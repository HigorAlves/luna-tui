// The rules pre-pass over Slack messages: the user-editable markdown file (VIPs, muted
// channels, always-P0 keywords, quiet hours, the reply SLA, notes for the model, learned
// priors) parsed once per poll and applied before the model sees anything. Deterministic and free; what it
// settles never reaches the model, what it floors the model cannot lower.
import type { SlackPriority, SlackTriage, SlackWatch } from "@hardness/contracts";

import { higher, watchFloor } from "./slack-item.ts";

export interface QuietHours {
  /** Minutes after midnight, local time. */
  start: number;
  end: number;
}

export interface LearnedPrior {
  direction: "lowered" | "raised";
  n: number;
}

export interface SlackRules {
  /** `@name` or `U…` entries, lower-cased, without the `@`. */
  vips: string[];
  /** `#name` or `C…` entries, lower-cased, without the `#`. */
  muted: string[];
  p0Keywords: string[];
  quietHours: QuietHours | null;
  notes: string;
  /** Keyed by `@author` or `#channel`. */
  learned: Record<string, LearnedPrior>;
  /** Seconds you give yourself to reply, by priority; null when that priority has no SLA. */
  sla: SlaTargets;
}

export type SlaTargets = Record<SlackPriority, number | null>;

/** The reply SLA when the file says nothing: 10m, 30m, 1h, 1h. */
export const DEFAULT_SLA: SlaTargets = { P0: 600, P1: 1800, P2: 3600, P3: 3600 };

export const EMPTY_RULES: SlackRules = { vips: [], muted: [], p0Keywords: [], quietHours: null, notes: "", learned: {}, sla: DEFAULT_SLA };

/** The file a fresh install starts from (also docs/agents/slack-triage.md). */
export const RULES_TEMPLATE = `# Slack triage rules

The inbox reads this file before every poll. Edit it freely; one entry per line, \`-\` bullets.
Lines starting with \`<!--\` are comments.

## VIPs

<!-- People whose messages are at least P1: @handle or user id, one per line. -->
<!-- - @cto -->

## Muted channels

<!-- Messages here are never stored and never leave the machine: #name or channel id. -->
<!-- - #random -->

## Always P0 keywords

<!-- A message containing one of these (case-insensitive) is P0. -->
- incident
- outage

## Quiet hours

<!-- HH:MM-HH:MM local time; only P0 raises a notice in this window. Leave empty for none. -->
<!-- 22:00-08:00 -->

## SLA

<!-- How long you give yourself to reply, by priority: Nm, Nh, N (seconds) or off. An item
     past its target turns red on the board. Missing lines fall back to these values. -->
- P0: 10m
- P1: 30m
- P2: 1h
- P3: 1h

## Notes

<!-- Free text the model reads: tone, context, who is who. -->
<!-- Replies to the data team are in PT-BR. Keep replies short, no emoji. -->

## Learned

<!-- Maintained by the inbox from what you do: "- @author: lowered (3)" after items cleared
     without a reply, "raised" after quick replies. Edit or delete lines as you like. -->
`;

const SECTIONS: Record<string, keyof SlackRules | "quiet"> = {
  vips: "vips",
  "muted channels": "muted",
  "always p0 keywords": "p0Keywords",
  "quiet hours": "quiet",
  sla: "sla",
  notes: "notes",
  learned: "learned",
};

const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");
const bullets = (body: string): string[] =>
  stripComments(body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);

function parseQuietHours(body: string): QuietHours | null {
  const match = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(stripComments(body));
  if (!match) return null;
  const [, sh, sm, eh, em] = match;
  return { start: Number(sh) * 60 + Number(sm), end: Number(eh) * 60 + Number(em) };
}

const LEARNED_LINE = /^(.+?):\s*(lowered|raised)\s*\((\d+)\)$/;
const SLA_LINE = /^(P[0-3]):\s*(off|(\d+)\s*([mh]?))$/i;

/** `- P1: 30m` lines; `off` means none, anything unreadable keeps the default. */
function parseSla(body: string): SlaTargets {
  const sla: SlaTargets = { ...DEFAULT_SLA };
  for (const line of bullets(body)) {
    const match = SLA_LINE.exec(line);
    if (!match) continue;
    const [, priority, value, n, unit] = match;
    const key = priority!.toUpperCase() as SlackPriority;
    if (value!.toLowerCase() === "off") sla[key] = null;
    else sla[key] = Number(n) * (unit!.toLowerCase() === "h" ? 3600 : unit!.toLowerCase() === "m" ? 60 : 1);
  }
  return sla;
}

/** The rules file, section by section. Unknown sections are ignored; a missing one is empty. */
export function parseRules(markdown: string): SlackRules {
  const rules: SlackRules = { ...EMPTY_RULES, vips: [], muted: [], p0Keywords: [], learned: {}, sla: { ...DEFAULT_SLA } };
  const parts = markdown.split(/^## +/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase();
    const body = newline === -1 ? "" : part.slice(newline + 1);
    const section = SECTIONS[heading];
    if (!section) continue;
    if (section === "vips") rules.vips = bullets(body).map((v) => v.replace(/^@/, "").toLowerCase());
    else if (section === "muted") rules.muted = bullets(body).map((v) => v.replace(/^#/, "").toLowerCase());
    else if (section === "p0Keywords") rules.p0Keywords = bullets(body).map((v) => v.toLowerCase());
    else if (section === "quiet") rules.quietHours = parseQuietHours(body);
    else if (section === "sla") rules.sla = parseSla(body);
    else if (section === "notes") rules.notes = stripComments(body).trim();
    else if (section === "learned") {
      for (const line of bullets(body)) {
        const match = LEARNED_LINE.exec(line);
        if (match) rules.learned[match[1]!.trim()] = { direction: match[2] as LearnedPrior["direction"], n: Number(match[3]) };
      }
    }
  }
  return rules;
}

/** True inside the quiet window; a window across midnight (22:00-08:00) wraps. */
export function inQuietHours(rules: SlackRules, now: Date): boolean {
  const q = rules.quietHours;
  if (!q) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return q.start <= q.end ? minutes >= q.start && minutes < q.end : minutes >= q.start || minutes < q.end;
}

export interface RuleInput {
  author: { id: string; name: string; isBot: boolean };
  /** Lower-cased comparisons are made on this; pass the plain text. */
  text: string;
  channel: { id: string; name: string };
  /** The text mentions you by handle. */
  mentionsMe: boolean;
  /** You wrote it. */
  isOwn: boolean;
  /** The watch keys the message tripped. */
  matched: string[];
  watches: SlackWatch[];
}

export type RuleVerdict =
  /** Not an item at all: your own message, or a muted channel. */
  | { drop: true; reason: "own" | "muted" }
  | {
      drop: false;
      /** Set when the rules settled triage without the model (bot authors). */
      triage: SlackTriage | null;
      /** The model's priority cannot be lower than this. */
      floor: SlackPriority | null;
    };

function isMuted(rules: SlackRules, channel: RuleInput["channel"]): boolean {
  return rules.muted.includes(channel.id.toLowerCase()) || rules.muted.includes(channel.name.toLowerCase());
}

function isVip(rules: SlackRules, author: RuleInput["author"]): boolean {
  return rules.vips.includes(author.id.toLowerCase()) || rules.vips.includes(author.name.toLowerCase());
}

/** The pre-pass for one message. */
export function applyRules(input: RuleInput, rules: SlackRules, now: Date): RuleVerdict {
  if (input.isOwn) return { drop: true, reason: "own" };
  if (isMuted(rules, input.channel)) return { drop: true, reason: "muted" };
  const text = input.text.toLowerCase();
  let floor: SlackPriority | null = watchFloor(input.matched, input.watches);
  if (isVip(rules, input.author)) floor = higher(floor, "P1");
  if (rules.p0Keywords.some((word) => text.includes(word))) floor = higher(floor, "P0");
  if (input.author.isBot && !input.mentionsMe) {
    return {
      drop: false,
      floor,
      triage: {
        priority: floor ?? "P3",
        category: "automated",
        expectsReply: false,
        summary: firstLine(input.text),
        why: "posted by an app",
        draft: null,
        refs: [],
        deadline: null,
        by: "rules",
        triagedAt: now.toISOString(),
        overridden: false,
      },
    };
  }
  return { drop: false, triage: null, floor };
}

/** Triage with the floor applied; a hand override is left alone. */
export function withFloor(triage: SlackTriage, floor: SlackPriority | null): SlackTriage {
  if (floor === null || triage.overridden) return triage;
  const priority = higher(triage.priority, floor) ?? triage.priority;
  return priority === triage.priority ? triage : { ...triage, priority };
}

/** The first line of a text, cut to fit the row. */
export function firstLine(text: string, max = 90): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Records what you did under `## Learned`: one line per key, the counter bumped when the
 * direction repeats and reset when it flips. Appends the section when the file lacks it.
 */
export function learn(markdown: string, key: string, direction: LearnedPrior["direction"]): string {
  const current = parseRules(markdown).learned[key];
  const n = current?.direction === direction ? current.n + 1 : 1;
  const line = `- ${key}: ${direction} (${n})`;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = new RegExp(`^- ${escaped}: (lowered|raised) \\(\\d+\\)\\s*$`, "m");
  if (existing.test(markdown)) return markdown.replace(existing, line);
  const heading = /^## +Learned[^\n]*\n/m.exec(markdown);
  if (!heading) return `${markdown.trimEnd()}\n\n## Learned\n\n${line}\n`;
  // After the heading and any comment block that follows it.
  let at = heading.index + heading[0].length;
  const rest = markdown.slice(at);
  const comment = /^\s*<!--[\s\S]*?-->\s*\n?/.exec(rest);
  if (comment) at += comment[0].length;
  return `${markdown.slice(0, at)}${line}\n${markdown.slice(at)}`;
}
