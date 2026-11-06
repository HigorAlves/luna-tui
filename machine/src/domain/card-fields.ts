// What a card keeps of the entry contract (`create_card`): pure, so every intake and the HTTP route store the same shape.
// Every text is a stranger's: flattened and capped, every list bounded, an attachment a reference with a web address.
import { type Bands, SCORING_DEFAULTS, type Weights, scorePriority, type TriageRecord } from "@hardness/contracts";
import { WEB_URL } from "@hardness/contracts";
import type { CardAttachment, CardFields, CardHints, CardSource, OriginMachine, Reporter, TaskSource } from "@hardness/contracts";

import { safe } from "./evidence-markdown.ts";

export const MAX_SOURCES = 20;
export const MAX_ATTACHMENTS = 20;
export const MAX_OWNERS = 20;
export const MAX_FOLLOWERS = 50;
export const MAX_LINKS = 20;
const TEXT = 120;
const URL_MAX = 2000;

type Source = TaskSource | CardSource;

export interface CardFieldsInput {
  source?: TaskSource | null;
  sources?: Source[];
  reporter?: { id: string; channel?: string; name?: string };
  hints?: CardHints;
  originMachine?: OriginMachine;
  attachments?: { name: string; url: string; mediaType?: string; size?: number }[];
  project?: string;
  owners?: string[];
  followers?: string[];
  links?: Record<string, string>;
}

/** Text a stranger wrote: no markup, one line, capped. */
const text = (value: string, max = TEXT): string => safe(value).slice(0, max).trim();
const web = (url: string): boolean => WEB_URL.test(url.trim());
/** An identifier (a login, a team, a project key): only letters, digits and `@ / . _ -` survive, capped, so it cannot carry markup, a link or a control character. `@team` still matches; output escapes it again. */
const ident = (value: string, max = TEXT): string => value.replace(/[^\p{L}\p{N}@/._-]/gu, "").slice(0, max);
const list = (values: string[] | undefined, max: number): string[] =>
  [...new Set((values ?? []).map((v) => ident(v)).filter(Boolean))].slice(0, max);

/** A source keeps its shape; its strings lose line breaks and are capped (they are addresses, so no markup escaping). */
function cleanSource(source: Source): Source {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, URL_MAX) : value]),
  ) as Source;
}

/** Keys sorted: jsonb hands an object back in its own key order. */
const canon = (v: object): string => JSON.stringify(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
const sameSource = (a: Source, b: Source): boolean => canon(a) === canon(b);

/** The card's sources with `extra` after them, the first one untouched, no repeats, at most MAX_SOURCES. */
export function appendSource(sources: Source[], extra: Source): Source[] {
  const clean = cleanSource(extra);
  if (sources.some((s) => sameSource(s, clean)) || sources.length >= MAX_SOURCES) return sources;
  return [...sources, clean];
}

/** What a row keeps: the stored fields, else (a row from before wave 14) its one source and empty lists. */
export function cardOf(row: { card?: CardFields | null; source: TaskSource | null }): CardFields {
  return row.card ?? cardFieldsOf({ source: row.source });
}

export function cardFieldsOf(input: CardFieldsInput): CardFields {
  const sources: Source[] = [];
  for (const s of [...(input.source ? [input.source] : []), ...(input.sources ?? [])]) {
    const next = appendSource(sources, s);
    sources.splice(0, sources.length, ...next);
  }
  const hints = input.hints
    ? Object.fromEntries(
        Object.entries(input.hints)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, typeof v === "string" ? text(v) : v]),
      )
    : null;
  const attachments: CardAttachment[] = (input.attachments ?? [])
    .filter((a) => web(a.url))
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({
      name: text(a.name),
      url: a.url.trim().slice(0, URL_MAX),
      ...(a.mediaType ? { mediaType: text(a.mediaType) } : {}),
      ...(a.size !== undefined ? { size: a.size } : {}),
    }));
  const reporter: Reporter | null = input.reporter
    ? { id: ident(input.reporter.id), ...(input.reporter.channel ? { channel: ident(input.reporter.channel) } : {}), ...(input.reporter.name ? { name: text(input.reporter.name) } : {}) }
    : null;
  const links = Object.fromEntries(
    Object.entries(input.links ?? {})
      .filter(([, url]) => web(url))
      .slice(0, MAX_LINKS)
      .map(([k, url]) => [text(k), url.trim().slice(0, URL_MAX)]),
  );
  return {
    sources,
    reporter,
    hints: hints && Object.keys(hints).length ? (hints as CardHints) : null,
    originMachine: input.originMachine ?? null,
    attachments,
    project: input.project ? ident(input.project) || null : null,
    owners: list(input.owners, MAX_OWNERS),
    followers: list(input.followers, MAX_FOLLOWERS),
    links,
  };
}

const MAX_MERGED = 50;
const DEMAND_MAX = 3;

/** Distinct reporters of a card: its own and its followers. Demand is this count, at least 1. */
export const reportersOf = (card: Pick<CardFields, "reporter" | "followers">): number => Math.max(1, new Set([card.reporter?.id ?? "", ...card.followers].filter(Boolean)).size);

/** The kept card with a duplicate's report merged in: its sources after the kept ones, its reporter and followers following. The merge records what it
 *  added (a source or follower the kept card already had is not added, so it is not taken back); demand is the count of distinct reporters. Pure. */
export function mergeFields(kept: CardFields, dup: CardFields, dupId: string): CardFields {
  let sources = kept.sources;
  for (const source of dup.sources) sources = appendSource(sources, source);
  const addedSources = sources.slice(kept.sources.length);
  const who = [dup.reporter?.id ?? "", ...dup.followers].map((v) => ident(v)).filter(Boolean);
  const followers = [...new Set([...kept.followers, ...who])].slice(0, MAX_FOLLOWERS);
  const addedFollowers = followers.filter((f) => !kept.followers.includes(f) && f !== kept.reporter?.id);
  const next = { ...kept, sources, followers };
  return { ...next, demand: reportersOf(next), merged: [...(kept.merged ?? []), { id: dupId, sources: addedSources, followers: addedFollowers }].slice(-MAX_MERGED) };
}

/** The kept card without what that merge added: its sources (never the first) and followers; demand follows the reporters left. Pure. */
export function unmergeFields(kept: CardFields, dupId: string): CardFields {
  const entry = (kept.merged ?? []).find((m) => m.id === dupId);
  const gone = new Set((entry?.sources ?? []).map(canon));
  const leaving = new Set(entry?.followers ?? []);
  const sources = kept.sources.filter((s, i) => i === 0 || !gone.has(canon(s)));
  const next = { ...kept, sources, followers: kept.followers.filter((f) => !leaving.has(f)) };
  return { ...next, demand: reportersOf(next), merged: (kept.merged ?? []).filter((m) => m.id !== dupId) };
}

/** A triage record with its demand sub-score derived from the count of reporters (1 to 3) and the priority scored again; the record as it was when it has no sub-scores. Pure. */
export function withDemand(record: TriageRecord | null, count: number, scoring: { weights: Weights; bands: Bands } = { weights: SCORING_DEFAULTS.weights, bands: SCORING_DEFAULTS.bands }): TriageRecord | null {
  const detail = record?.urgencyDetail;
  if (!record || !detail) return record;
  const subScores = { ...detail.subScores, demand: Math.min(DEMAND_MAX, Math.max(1, count)) };
  return { ...record, urgencyDetail: { priority: scorePriority(subScores, scoring).priority, subScores } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DEPENDENCIES = 20;

/** What the machine alone says about a card in a stack (`NewTask.stack`): well-formed ids only, bounded lists, a floor that is a level. A card made from a split has its duplicate check marked answered, so wave 14's check never merges two parts of one split. Pure. */
export function stackFieldsOf(
  stack: { splitFrom?: string; splitPart?: { n: number; of: number }; dependsOn?: string[]; startWhenReady?: boolean; riskFloor?: "low" | "medium" | "high" } | undefined,
  at: string,
): Partial<CardFields> {
  if (!stack) return {};
  const splitFrom = stack.splitFrom && UUID.test(stack.splitFrom) ? stack.splitFrom : undefined;
  const part = stack.splitPart;
  const splitPart = part && Number.isInteger(part.n) && Number.isInteger(part.of) && part.n >= 1 && part.of >= 2 && part.of <= 20 && part.n <= part.of ? { n: part.n, of: part.of } : undefined;
  const dependsOn = [...new Set((stack.dependsOn ?? []).filter((id) => UUID.test(id)))].slice(0, MAX_DEPENDENCIES);
  const riskFloor = stack.riskFloor === "low" || stack.riskFloor === "medium" || stack.riskFloor === "high" ? stack.riskFloor : undefined;
  return {
    ...(splitFrom ? { splitFrom } : {}),
    ...(splitPart ? { splitPart } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(stack.startWhenReady === true ? { startWhenReady: true } : {}),
    ...(riskFloor ? { riskFloor } : {}),
    ...(splitFrom ? { dedup: { at, recordId: null, candidates: [], answer: null, outcome: "none" as const, chosen: "neither" as const } } : {}),
  };
}
