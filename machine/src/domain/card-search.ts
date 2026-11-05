// The board search triage's agent may ask for (the read-only `card_search` luna tool): which cards of this repository
// look like a topic. Open cards and those closed or archived in the last 90 days, matched on title and summary by shared
// words; the answer is ids, titles, states and a one-line summary, at most ten, and never a card of another repository. Pure.
import { tokens } from "./graph-locate.ts";

export interface CardHit {
  id: string;
  title: string;
  state: string;
  summary: string;
}

interface SearchableCard {
  id: string;
  title: string;
  description: string;
  state: string;
  repoPath: string | null;
  stateSince: Date | null;
  record?: { summary?: string } | null;
}

const ENDED = new Set(["closed", "archived"]);
export const MAX_CARD_HITS = 10;
const SUMMARY_CHARS = 120;
const MAX_QUERY_CHARS = 300;
const DAY_MS = 86_400_000;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_CHARS);

export function searchCards(cards: SearchableCard[], query: string, options: { repoPath: string | null; selfId: string; now: Date; days?: number }): CardHit[] {
  // A card with no repository has no neighbours: nothing is shared across repositories.
  if (!options.repoPath) return [];
  const wanted = new Set(tokens(query.slice(0, MAX_QUERY_CHARS)));
  if (wanted.size === 0) return [];
  const since = options.now.getTime() - (options.days ?? 90) * DAY_MS;
  const hits: Array<CardHit & { score: number }> = [];
  for (const card of cards) {
    if (card.id === options.selfId || card.repoPath !== options.repoPath) continue;
    if (ENDED.has(card.state) && (!card.stateSince || card.stateSince.getTime() < since)) continue;
    const summary = oneLine(card.record?.summary ?? card.description);
    const have = new Set(tokens(`${card.title} ${summary}`));
    let score = 0;
    for (const t of wanted) if (have.has(t)) score++;
    if (score > 0) hits.push({ id: card.id, title: card.title.slice(0, 200), state: card.state, summary, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, MAX_CARD_HITS)
    .map(({ score: _score, ...hit }) => hit);
}
