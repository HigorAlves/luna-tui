// The board search triage's agent may ask for (the read-only `card_search` luna tool): which cards of this repository
// look like a topic. Open cards and those closed or archived in the last 90 days, matched on the title by shared words;
// the answer is ids, titles and states, at most ten, never a summary or a description, never a card of another repository
// and never a card from another source: the agent reads untrusted text and may fetch URLs, so a GitHub-sourced card must not
// learn what a private Jira ticket or Slack thread says. A card typed in the TUI has no source and sees all: it is the operator's own. Pure.
import { tokens } from "./graph-locate.ts";

export interface CardHit {
  id: string;
  title: string;
  state: string;
}

interface SearchableCard {
  id: string;
  title: string;
  state: string;
  repoPath: string | null;
  stateSince: Date | null;
  /** Where the card came from (`github`, `jira`, `slack`, `notch`...); null for a card typed in the TUI. */
  source: { kind: string } | null;
}

const ENDED = new Set(["closed", "archived"]);
export const MAX_CARD_HITS = 10;
const MAX_QUERY_CHARS = 300;
const DAY_MS = 86_400_000;

export function searchCards(cards: SearchableCard[], query: string, options: { repoPath: string | null; selfId: string; /** The asking card's source kind; null when it has none. */ selfSource: string | null; now: Date; days?: number }): CardHit[] {
  // A card with no repository has no neighbours: nothing is shared across repositories.
  if (!options.repoPath) return [];
  const wanted = new Set(tokens(query.slice(0, MAX_QUERY_CHARS)));
  if (wanted.size === 0) return [];
  const since = options.now.getTime() - (options.days ?? 90) * DAY_MS;
  const hits: Array<CardHit & { score: number }> = [];
  for (const card of cards) {
    if (card.id === options.selfId || card.repoPath !== options.repoPath) continue;
    // A card sees only cards of its own source kind, unless it has none.
    if (options.selfSource !== null && card.source?.kind !== options.selfSource) continue;
    if (ENDED.has(card.state) && (!card.stateSince || card.stateSince.getTime() < since)) continue;
    const have = new Set(tokens(card.title));
    let score = 0;
    for (const t of wanted) if (have.has(t)) score++;
    if (score > 0) hits.push({ id: card.id, title: card.title.slice(0, 200), state: card.state, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, MAX_CARD_HITS)
    .map(({ score: _score, ...hit }) => hit);
}
