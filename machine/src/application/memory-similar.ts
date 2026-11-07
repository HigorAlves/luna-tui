// Memory's part in Intake and Triage (RFC 0007, Goal 2): which past cards a new card resembles, by vectors. The recall goes
// through the port, so the visibility rule is the dataset list the port picks for the viewer; a card sees what its own source
// sees. Memory off, or a failed recall, is no cards: callers behave exactly as they did before memory.
import type { RecalledMemory, TaskSource } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { MemoryViewer } from "../domain/memory-datasets.ts";
import type { Memory } from "./memory.ts";

type SimilarKind = "outcome" | "finding";
const SIMILAR_KINDS: SimilarKind[] = ["outcome", "finding"];
const SIMILAR_LIMIT = 12;
const OUTCOME_TEXT = 400;

/** The viewer a new card recalls as: its own source (the first one a card keeps); a card with no source, or one the notch made, is the operator's own (`tui`). */
export function viewerOfCard(card: { repoSlug: string; source: TaskSource | null }): Extract<MemoryViewer, { kind: "card" }> {
  const s = card.source;
  const base = { kind: "card" as const, repo: card.repoSlug, publicPost: false };
  if (!s) return { ...base, source: { kind: "tui", ref: null } };
  switch (s.kind) {
    case "github":
    case "github_pr":
      return { ...base, source: { kind: "github", ref: s.repo } };
    case "slack":
      return { ...base, source: { kind: "slack", ref: s.channel } };
    case "jira":
      return { ...base, source: { kind: "jira", ref: s.key.split("-")[0] ?? s.key } };
    case "notch":
      return { ...base, source: { kind: "tui", ref: null } };
  }
}

export interface SimilarPast {
  /** The card the item is about (`provenance.card`), when the item names one. */
  card: string | null;
  item: RecalledMemory;
}

/** Past `outcome` and `finding` items like this card's title and text, each mapped to its card. Never throws. */
export async function recallSimilar(memory: Memory, card: { title: string; text: string }, viewer: MemoryViewer, kinds: SimilarKind[] = SIMILAR_KINDS): Promise<SimilarPast[]> {
  if (!memory.enabled) return [];
  try {
    const query = `${card.title}\n${card.text}`.slice(0, 2000);
    const { items } = await memory.recall({ query, viewer, kinds, scope: "memory", limit: SIMILAR_LIMIT });
    const out: SimilarPast[] = [];
    for (const item of items) {
      const row = await memory.get(item.id).catch(() => null);
      out.push({ card: row?.provenance.card ?? null, item });
    }
    return out;
  } catch {
    return [];
  }
}

/** The ids of the cards memory says look like this one, best first, once each. */
export async function similarCardIds(memory: Memory, card: { title: string; text: string }, viewer: MemoryViewer): Promise<string[]> {
  const found = await recallSimilar(memory, card, viewer);
  return [...new Set(found.flatMap((f) => (f.card ? [f.card] : [])))];
}

/** What triage is shown of similar past cards: the recalled `outcome` text (the machine's template: predicted against actual), flattened and capped, at most five, never the card itself. */
export async function similarOutcomes(memory: Memory, card: { title: string; text: string; id?: string }, viewer: MemoryViewer): Promise<Array<{ card: string | null; text: string }>> {
  const found = await recallSimilar(memory, card, viewer, ["outcome"]);
  const seen = new Set<string>();
  const out: Array<{ card: string | null; text: string }> = [];
  for (const f of found) {
    if (f.item.kind !== "outcome" || (f.card && f.card === card.id)) continue;
    const key = f.card ?? f.item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ card: f.card, text: safe(f.item.text).slice(0, OUTCOME_TEXT) });
    if (out.length === 5) break;
  }
  return out;
}
