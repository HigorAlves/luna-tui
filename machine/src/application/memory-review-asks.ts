// Reviewer preferences in memory (RFC 0007, Goal 3). When a card's PR merges, each review thread that led to a fix or a change request becomes one
// `review_ask` item: who asked (a repository's own person, never the machine), their team when CODEOWNERS names one, the kind of ask and the file,
// by a template, with at most a short flattened excerpt of the comment. Before the implementing run the asks for the plan's files and their owners
// are recalled and join the pushed `context.memory` block. Pure functions here, and two calls through the port; memory off is nothing.
import { MEMORY_CONTEXT_MAX_BYTES, MEMORY_CONTEXT_MAX_ITEMS, MEMORY_TEXT_MAX, type MemoryContext, type RecalledMemory, type TaskSource } from "@hardness/contracts";

import { carriesSecret, postable } from "../domain/postable.ts";
import type { MemoryViewer } from "../domain/memory-datasets.ts";
import { viewerOfCard } from "./memory-similar.ts";
import type { Memory, MemoryItemDraft } from "./memory.ts";

/** The longest excerpt of a reviewer's comment an item may carry. */
export const EXCERPT_MAX = 150;
/** How many asks the pushed block takes from here, so M2's own items keep room. */
export const REVIEW_ASKS_LIMIT = 6;
const PLAN_FILES_MAX = 30;
const OWNERS_MAX = 10;

/** One review thread that led to a fix or a change request, as the ship monitor saw it. */
export interface ReviewAskFact {
  thread: string;
  reviewer: string;
  kind: "change_request" | "nit";
  path: string | null;
  /** The comment, flattened by `postable` and capped to `EXCERPT_MAX`. */
  excerpt: string;
}

const login = (text: string): string => postable(text, 60).replace(/[^A-Za-z0-9_.-]/g, "");

/** The comment's excerpt as it may be kept: flattened and short, and none at all when it holds a token-shaped string. */
export const excerptOf = (body: string): string => (carriesSecret(body) ? "" : postable(body, EXCERPT_MAX));

/** The items of a merged PR's review asks. `teamOf` is the CODEOWNERS team of a path, when it has one. Only the facts given; nothing is read from GitHub here. */
export function reviewAskDrafts(card: { id: string; repo: string; source: TaskSource | null }, facts: ReviewAskFact[], teamOf: (path: string) => string | null): MemoryItemDraft[] {
  const source = viewerOfCard({ repoSlug: card.repo, source: card.source }).source;
  const seen = new Set<string>();
  const drafts: MemoryItemDraft[] = [];
  for (const f of facts) {
    const who = login(f.reviewer);
    if (!who || seen.has(f.thread)) continue;
    seen.add(f.thread);
    const team = f.path ? teamOf(f.path) : null;
    const what = f.kind === "nit" ? "a nit" : "a change";
    const excerpt = f.excerpt ? postable(f.excerpt, EXCERPT_MAX) : "";
    const text = `Reviewer ${who}${team ? ` (team ${team.replace(/^@/, "")})` : ""} asked for ${what}${f.path ? ` in ${f.path}` : ""} on a merged PR${excerpt ? `: "${excerpt}"` : ""}.`.slice(0, MEMORY_TEXT_MAX);
    drafts.push({
      kind: "review_ask",
      repo: card.repo,
      source,
      anchors: { files: f.path ? [f.path] : [], commit: null },
      provenance: { by: "machine", card: card.id, run: null, pack: null },
      trust: "fact",
      text,
    });
  }
  return drafts;
}

/** Writes the asks of a merged card. Never throws: a failed write is a lost note, not a failed merge. */
export async function writeReviewAsks(memory: Memory, card: { id: string; repo: string; source: TaskSource | null }, facts: ReviewAskFact[], teamOf: (path: string) => string | null): Promise<number> {
  if (!memory.enabled || facts.length === 0) return 0;
  try {
    const drafts = reviewAskDrafts(card, facts, teamOf);
    if (drafts.length === 0) return 0;
    return (await memory.write(drafts)).length;
  } catch {
    return 0;
  }
}

/** The plan's files, from its slices' touchpoints (any shape: a plan on the input is loosely typed), once each. */
export function planFilesOf(plan: unknown): string[] {
  const p = plan as { slices?: unknown; map?: { files?: unknown } | null } | null | undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
  const fromSlices = Array.isArray(p?.slices) ? p.slices.flatMap((s) => strings((s as { touchpoints?: unknown } | null)?.touchpoints)) : [];
  const fromMap = Array.isArray(p?.map?.files) ? p.map.files.flatMap((f) => strings([(f as { path?: unknown } | null)?.path])) : [];
  return [...new Set([...fromSlices, ...fromMap])].slice(0, PLAN_FILES_MAX);
}

/** The recall for the plan's files and their owners: one query naming both, kind `review_ask` only. */
export function reviewAsksQuery(files: string[], owners: string[]): { query: string; kinds: ["review_ask"] } {
  const f = [...new Set(files)].slice(0, PLAN_FILES_MAX);
  const o = [...new Set(owners.map((x) => x.replace(/^@/, "")))].slice(0, OWNERS_MAX);
  const query = [`Review asks for changes in ${f.join(", ")}`, o.length ? `Reviewers and teams that own them: ${o.join(", ")}` : ""].filter(Boolean).join("\n").slice(0, 2000);
  return { query, kinds: ["review_ask"] };
}

/** Review asks for the files a plan touches and the people who own them. Never throws; with no file there is nothing to ask for. */
export async function recallReviewAsks(memory: Memory, input: { files: string[]; owners: string[]; viewer: MemoryViewer }): Promise<RecalledMemory[]> {
  if (!memory.enabled || input.files.length === 0) return [];
  try {
    const { query, kinds } = reviewAsksQuery(input.files, input.owners);
    const result = await memory.recall({ query, kinds, viewer: input.viewer, scope: "memory", limit: REVIEW_ASKS_LIMIT });
    return result.items.filter((i) => i.kind === "review_ask");
  } catch {
    return [];
  }
}

const bytesOf = (items: RecalledMemory[]): number => Buffer.byteLength(JSON.stringify(items));

/**
 * `context.memory` with these asks added after what is there: items already in the block are kept as they are, an ask whose id is present is not
 * repeated, and the block never passes the contract's 12 items or 4 KB (what does not fit is dropped, with a note). Null when nothing changes.
 */
export function mergeReviewAsks(existing: MemoryContext | undefined, asks: RecalledMemory[]): MemoryContext | null {
  if (asks.length === 0) return null;
  const items = [...(existing?.items ?? [])];
  const have = new Set(items.map((i) => i.id));
  let dropped = 0;
  for (const ask of asks) {
    if (have.has(ask.id)) continue;
    if (items.length >= MEMORY_CONTEXT_MAX_ITEMS || bytesOf([...items, ask]) > MEMORY_CONTEXT_MAX_BYTES) {
      dropped++;
      continue;
    }
    have.add(ask.id);
    items.push(ask);
  }
  if (items.length === (existing?.items.length ?? 0) && dropped === 0) return null;
  const cut = dropped > 0 ? `${dropped} review ask${dropped === 1 ? "" : "s"} left out to fit the block` : null;
  const note = [existing?.note, cut].filter(Boolean).join("; ").slice(0, 300) || null;
  return { items, note };
}
