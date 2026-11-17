// The ticket safety screen, minus the model: a pre-pass over the RAW text that counts what a human cannot see, and the outcome a script
// takes from the pack's answers. Pure. It runs before `safe()`, which inserts zero-width characters and rewrites links.
import { createHash } from "node:crypto";

import { SAFETY_REASONS, type SafetyReason } from "@hardness/contracts";

/** `full` is the hash of the text before the canonical caps (`CanonicalTicket.textHash`), when the intake read it. */
export type RawTicket = { title: string; description: string; comments: string[]; full?: string };

/**
 * The most ticket text a card, a backlog item or a task may carry, and the most the screen reads: every card is capped to it, so no card carries a character the screen did not read.
 * (The canonical ticket's own caps are lower; this bounds the text that reaches a card without passing through it: a Slack message, a split child, a raw issue body.)
 */
export const SCREENED_TEXT_LIMIT = 32000;

/** The most flattened text one screen call reads (title apart). */
export const SCREEN_CHUNK = 4000;

/** Consecutive description parts share this many characters, so an instruction split by a boundary is whole in one part. */
export const SCREEN_OVERLAP = 500;

/** Comment texts cut so that all of them together hold at most `SCREENED_TEXT_LIMIT` characters (the last one that fits is cut; later ones are dropped). The screen reads exactly these. */
export function screenedComments(texts: readonly string[]): string[] {
  let left = SCREENED_TEXT_LIMIT;
  const out: string[] = [];
  for (const t of texts) {
    if (left <= 0) break;
    out.push(t.slice(0, left));
    left -= t.length;
  }
  return out;
}

/** `text` cut to what a card may carry. */
export const cardText = (text: string): string => (text.length > SCREENED_TEXT_LIMIT ? text.slice(0, SCREENED_TEXT_LIMIT) : text);

export type Prepass = { invisible: number; bidi: number; tagChars: number; htmlComments: number; encodedRuns: number; linkMismatch: number; hard: boolean };

/** One ticket_safety answer: each question's yes/no with its probability. */
export type SafetyAnswer = Record<string, { value: boolean; p: number }>;

/** A yes/no is a yes from a coin toss up; it is sure from here. */
const YES = 0.5;
const SURE = 0.85;

/** A comment holds prose past this many non-space characters; every issue template's comments are shorter. */
const COMMENT_PROSE = 40;

const ZERO_WIDTH = /[​‌‍⁠﻿]/;
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|️/u;
const ENCODED = /[A-Za-z0-9+/=]{80,}|[0-9a-fA-F]{64,}/g;
const LINK = /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)/g;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/** Zero-width characters, except a ZWJ that joins emoji: it follows an emoji and precedes one. */
function invisibleIn(text: string): number {
  const chars = [...text];
  let n = 0;
  chars.forEach((c, i) => {
    if (!ZERO_WIDTH.test(c)) return;
    const joins = c === "‍" && i > 0 && EMOJI.test(chars[i - 1]!) && i + 1 < chars.length && EMOJI.test(chars[i + 1]!);
    if (!joins) n += 1;
  });
  return n;
}

function commentsIn(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) if (m[1]!.replace(/\s+/g, "").length > COMMENT_PROSE) n += 1;
  return n;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Links whose visible text is a web address (a scheme or `www.`) for a different host than the link goes to. */
function mismatchesIn(text: string): number {
  let n = 0;
  for (const m of text.matchAll(LINK)) {
    const label = m[1]!.trim();
    if (!/^(https?:\/\/|www\.)\S+$/i.test(label)) continue;
    const shown = hostOf(/^www\./i.test(label) ? `https://${label}` : label);
    const target = hostOf(m[2]!);
    if (shown && target && shown !== target) n += 1;
  }
  return n;
}

/** What the raw text hides from a reader: counts, no model. `hard` is a signal no honest ticket has. */
export function prepass(raw: RawTicket): Prepass {
  const text = [raw.title, raw.description, ...raw.comments].join("\n");
  const invisible = invisibleIn(text);
  const bidi = count(text, BIDI);
  const tagChars = count(text, TAGS);
  return { invisible, bidi, tagChars, htmlComments: commentsIn(text), encodedRuns: count(text, ENCODED), linkMismatch: mismatchesIn(text), hard: bidi > 0 || tagChars > 0 || invisible > 0 };
}

/** The counts the pack reads as evidence (tag characters count as invisible). */
export function signalsOf(p: Prepass): { invisible: number; bidi: number; htmlComments: number; encodedRuns: number; linkMismatch: number } {
  return { invisible: p.invisible + p.tagChars, bidi: p.bidi, htmlComments: p.htmlComments, encodedRuns: p.encodedRuns, linkMismatch: p.linkMismatch };
}

/** The outcome. Unsafe: a sure yes, or a hard signal with any yes. Suspicious: any yes, or a signal alone. The model never picks it. */
export function screenOutcome(answer: SafetyAnswer, p: Prepass): { verdict: "safe" | "suspicious" | "unsafe"; reasons: SafetyReason[] } {
  const yes = Object.entries(answer).filter(([, a]) => a.p >= YES);
  const found = new Set<string>(yes.map(([key]) => key));
  if (p.htmlComments > 0) found.add("hidden_content");
  if (p.hard) found.add("hidden_text");
  if (p.encodedRuns > 0) found.add("encoded_blob");
  if (p.linkMismatch > 0) found.add("link_mismatch");
  const reasons = SAFETY_REASONS.filter((r) => found.has(r));
  const signal = p.hard || p.htmlComments > 0 || p.encodedRuns > 0 || p.linkMismatch > 0;
  const unsafe = yes.some(([, a]) => a.p >= SURE) || (p.hard && yes.length > 0);
  return { verdict: unsafe ? "unsafe" : yes.length > 0 || signal ? "suspicious" : "safe", reasons };
}

/** No engine could answer: the ticket is held, never waved through. */
export function screenFailed(): { verdict: "suspicious"; reasons: ["screen_failed"] } {
  return { verdict: "suspicious", reasons: ["screen_failed"] };
}

/** A hash of everything the screen read, so an edited ticket is screened again. */
export function contentHash(raw: RawTicket): string {
  return createHash("sha256").update(JSON.stringify(raw.full ? [raw.title, raw.description, raw.comments, raw.full] : [raw.title, raw.description, raw.comments])).digest("hex");
}
