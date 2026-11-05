// What a card keeps of the entry contract (`create_card`): pure, so every intake and the HTTP route store the same shape.
// Every text is a stranger's: flattened and capped, every list bounded, an attachment a reference with a web address.
import { SCORING_DEFAULTS, scorePriority, type TriageRecord } from "@hardness/contracts";
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
const web = (url: string): boolean => /^https?:\/\//i.test(url.trim());
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
const canon = (v: Source): string => JSON.stringify(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
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

/** The kept card with a duplicate's report merged in: its sources after the kept ones, its reporter and followers following, the demand up by one. Pure. */
export function mergeFields(kept: CardFields, dup: CardFields, dupId: string): CardFields {
  let sources = kept.sources;
  for (const source of dup.sources) sources = appendSource(sources, source);
  const who = [dup.reporter?.id ?? "", ...dup.followers].map((v) => ident(v)).filter(Boolean);
  return {
    ...kept,
    sources,
    followers: [...new Set([...kept.followers, ...who])].slice(0, MAX_FOLLOWERS),
    demand: (kept.demand ?? 1) + 1,
    merged: [...(kept.merged ?? []), { id: dupId }].slice(-MAX_MERGED),
  };
}

/** The kept card without what a merge added: the duplicate's sources (never the first), its followers (but not the kept card's own reporter), one demand. Pure. */
export function unmergeFields(kept: CardFields, dup: CardFields, dupId: string): CardFields {
  const gone = new Set((dup.sources ?? []).map((s) => JSON.stringify(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1)))));
  const first = kept.sources[0];
  const own = new Set([kept.reporter?.id ?? ""]);
  const leaving = new Set([dup.reporter?.id ?? "", ...dup.followers].map((v) => ident(v)));
  return {
    ...kept,
    sources: kept.sources.filter((s, i) => i === 0 || s === first || !gone.has(JSON.stringify(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1))))),
    followers: kept.followers.filter((v) => own.has(v) || !leaving.has(v)),
    demand: Math.max(1, (kept.demand ?? 1) - 1),
    merged: (kept.merged ?? []).filter((m) => m.id !== dupId),
  };
}

/** A triage record with its demand sub-score moved by `delta` (0 to 4) and the priority scored again; the record as it was when it has no sub-scores. Pure. */
export function withDemand(record: TriageRecord | null, delta: number): TriageRecord | null {
  const detail = record?.urgencyDetail;
  if (!record || !detail) return record;
  const demand = Math.min(DEMAND_MAX, Math.max(0, detail.subScores.demand + delta));
  const subScores = { ...detail.subScores, demand };
  return { ...record, urgencyDetail: { priority: scorePriority(subScores, { weights: SCORING_DEFAULTS.weights, bands: SCORING_DEFAULTS.bands }).priority, subScores } };
}
