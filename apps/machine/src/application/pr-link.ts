// What a PR under review is linked to: the board cards and Jira tickets it is the work of. By fact first, no model: a card whose
// Jira link or source key the PR names, whose branch is the PR's head branch, or whose recorded PR (a `pr.opened` event, or its
// source) is this PR. Only when the PR names no Jira key and no card matched does the `pr_link` decision look at open candidates
// (at most five Jira tickets and five cards), and it links only at its proceed bar: under it the best candidate is a suggestion,
// never an action. Nothing here fails a review: a search, a decision or a card that cannot be read is skipped with a log line.
import { type DecisionOverrides, PACKS, type PrLinkContext, type TaskSource, applyPolicy } from "@hardness/contracts";

import { searchCards } from "../domain/card-search.ts";
import { tokens } from "../domain/graph-locate.ts";
import type { TaskRow } from "../domain/task.ts";
import { type Jira, messageOf } from "./jira.ts";
import { findPrJiraKeys } from "./review-tickets.ts";

/** The part of a board card the linking reads: a `TaskRow` fits. */
export type LinkableCard = Pick<TaskRow, "id" | "title" | "description" | "criteria" | "state" | "route" | "repoPath" | "branch" | "source" | "jira" | "stateSince"> & Partial<Pick<TaskRow, "card">>;

export interface LinkedPr {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string | null;
  headRef: string;
}

export type CardFact = "jira" | "branch" | "pr";
export interface FactMatch {
  card: LinkableCard;
  fact: CardFact;
}

export interface CardLink {
  card: LinkableCard;
  how: "fact" | "decision";
  /** Which fact matched, for `how: "fact"`. */
  fact?: CardFact;
}

export interface JiraLink {
  key: string;
  how: "key" | "fact" | "decision";
}

export interface PrLinks {
  /** The tickets to read: the keys the PR names, then those of linked cards, then the one the decision picked. */
  jira: JiraLink[];
  cards: CardLink[];
  /** The best candidate of a decision that stayed under its bar; shown, never acted on. */
  suggestion?: { kind: "jira" | "card"; id: string; title: string; confidence: number; url?: string };
}

/** More cards or tickets than this on one review is noise. */
export const MAX_LINKED_CARDS = 3;
export const MAX_LINKED_TICKETS = 5;
/** The decision's shortlist: five of each kind. */
export const FALLBACK_JIRA = 5;
export const FALLBACK_CARDS = 5;
const BODY_CAP = 3000;
const FILES_CAP = 40;
const EXCERPT_CAP = 1000;
const TERMS = 6;
const ENDED = new Set(["closed", "archived"]);

export interface PrLinkDeps {
  /** The board as it is now. */
  cards(): Promise<LinkableCard[]>;
  /** The addresses of the PRs the machine opened for a card (its `pr.opened` events). */
  prUrls(cardId: string): Promise<string[]>;
  /** The `pr_link` decision; absent, or not available (no Jev credential), the fallback is skipped quietly. */
  decision?: {
    available(): Promise<boolean>;
    decide(context: PrLinkContext): Promise<Record<string, unknown>>;
    /** The repository's own bars for the pack. */
    overrides(repoPath: string | null): Promise<DecisionOverrides>;
  };
}

const normalUrl = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Every Jira key a card is tied to: its link, and each source that names one. */
export function jiraKeysOf(card: LinkableCard): string[] {
  const keys: string[] = [];
  const add = (key: string | null | undefined) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  add(card.jira?.key);
  const sources = [...(card.source ? [card.source] : []), ...(card.card?.sources ?? [])] as Array<TaskSource | { type?: string }>;
  for (const s of sources) {
    if ("kind" in s && s.kind === "jira") add(s.key);
    if ("kind" in s && s.kind === "notch") add(s.jiraKey);
  }
  return keys;
}

/** Whether a card's own sources name this PR. */
function sourceNamesPr(card: LinkableCard, pr: LinkedPr): boolean {
  const sources = [...(card.source ? [card.source] : []), ...(card.card?.sources ?? [])] as Array<TaskSource | { type?: string }>;
  return sources.some((s) => "kind" in s && s.kind === "github_pr" && sameRepo(s.repo, pr.repo) && s.number === pr.number);
}

/** The open cards (any state but closed or archived) that match the PR by a recorded fact, in the order of the board, each by the first fact that matched. A review task never matches, nor does `selfId`. */
export async function matchByFact(cards: LinkableCard[], pr: LinkedPr, keys: readonly string[], selfId: string, prUrls: (cardId: string) => Promise<string[]>): Promise<FactMatch[]> {
  const named = new Set(keys);
  const wanted = normalUrl(pr.url);
  const found: FactMatch[] = [];
  for (const card of cards) {
    if (found.length >= MAX_LINKED_CARDS) break;
    if (card.id === selfId || card.route === "review" || ENDED.has(card.state)) continue;
    if (named.size > 0 && jiraKeysOf(card).some((k) => named.has(k))) found.push({ card, fact: "jira" });
    else if (card.branch && card.branch === pr.headRef) found.push({ card, fact: "branch" });
    else if (sourceNamesPr(card, pr)) found.push({ card, fact: "pr" });
    // A card with a branch has had a worktree, so a PR may have been opened from it: its events are the last, dearest fact to read.
    else if (card.branch && (await prUrls(card.id).catch(() => [])).some((u) => normalUrl(u) === wanted)) found.push({ card, fact: "pr" });
  }
  return found;
}

export interface LinkDeps {
  links: PrLinkDeps;
  /** The Jira port; absent, there is nothing to search for the fallback. */
  jira?: Jira | null;
  /** The Jira projects the machine knows for the repo; none, and a key of any project counts, and no Jira search is made. */
  projects?: () => Promise<readonly string[]>;
  log?: (line: string) => void;
}

export interface LinkInput {
  pr: LinkedPr;
  /** The changed paths. */
  files: string[];
  repoPath: string | null;
  /** The review task's own id. */
  selfId: string;
}

const cap = (text: string, max: number): string => text.replace(/\r/g, "").trim().slice(0, max);

/** The JQL of the fallback's Jira search: open issues of the known projects that mention a word of the PR's title or branch. Words are letters and digits only, so nothing of the PR reaches the query's grammar. */
export function candidateJql(projects: readonly string[], words: readonly string[]): string | null {
  const safeProjects = projects.filter((p) => /^[A-Za-z][A-Za-z0-9_]*$/.test(p));
  const terms = [...new Set(words.filter((w) => /^[a-z0-9]+$/.test(w)))].slice(0, TERMS);
  if (safeProjects.length === 0 || terms.length === 0) return null;
  return `project in (${safeProjects.join(", ")}) AND statusCategory != Done AND (${terms.map((t) => `text ~ "${t}"`).join(" OR ")}) ORDER BY updated DESC`;
}

export async function linkReview(deps: LinkDeps, input: LinkInput): Promise<PrLinks> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const { pr } = input;
  let projects: readonly string[] = [];
  try {
    projects = (await deps.projects?.()) ?? [];
  } catch (error) {
    log(`review: the repo's Jira projects could not be read (${messageOf(error)}); accepting any project key`);
  }
  const named = findPrJiraKeys(pr, projects);
  let board: LinkableCard[] = [];
  try {
    board = await deps.links.cards();
  } catch (error) {
    log(`review: the board could not be read for links (${messageOf(error)})`);
  }
  const matches = await matchByFact(board, pr, named, input.selfId, deps.links.prUrls);

  const jira: JiraLink[] = named.map((key) => ({ key, how: "key" as const }));
  for (const m of matches) {
    for (const key of jiraKeysOf(m.card)) {
      if (jira.length < MAX_LINKED_TICKETS && !jira.some((j) => j.key === key)) jira.push({ key, how: "fact" });
    }
  }
  const cards: CardLink[] = matches.map((m) => ({ card: m.card, how: "fact" as const, fact: m.fact }));
  if (named.length > 0 || matches.length > 0) return { jira, cards };

  // Nothing named the work: the decision, when Jev is there to answer it.
  const decision = deps.links.decision;
  if (!decision || !(await decision.available().catch(() => false))) return { jira, cards };
  try {
    return await decide(deps, decision, input, projects, board, log);
  } catch (error) {
    log(`review: the PR link decision failed (${messageOf(error)}); nothing is linked`);
    return { jira, cards };
  }
}

type Candidate = { slot: number; kind: "jira" | "card"; id: string; title: string; excerpt: string; url?: string; card?: LinkableCard };

async function decide(deps: LinkDeps, decision: NonNullable<PrLinkDeps["decision"]>, input: LinkInput, projects: readonly string[], board: LinkableCard[], log: (line: string) => void): Promise<PrLinks> {
  const { pr } = input;
  const words = [...tokens(pr.title), ...tokens(pr.headRef)];
  const candidates: Candidate[] = [];

  const jql = deps.jira ? candidateJql(projects, words) : null;
  if (deps.jira && jql) {
    try {
      const page = await deps.jira.search(jql, { maxResults: FALLBACK_JIRA });
      for (const issue of page.issues.slice(0, FALLBACK_JIRA)) {
        candidates.push({ slot: candidates.length + 1, kind: "jira", id: issue.key, title: cap(issue.summary, 500), excerpt: cap(issue.description, EXCERPT_CAP), url: issue.url });
      }
    } catch (error) {
      log(`review: the Jira search for link candidates failed (${messageOf(error)}); judging the board's cards alone`);
    }
  }
  // Open feature cards of the repository. The asker is the operator, who chose this PR: no source filter applies (`selfSource` null).
  const open = board.filter((c) => !ENDED.has(c.state) && c.route === "feature");
  const byId = new Map(open.map((c) => [c.id, c]));
  const hits = searchCards(open.map((c) => ({ ...c, source: c.source, jira: c.jira })), `${pr.title} ${pr.headRef}`, { repoPath: input.repoPath, selfId: input.selfId, selfSource: null, now: new Date() });
  for (const hit of hits.slice(0, FALLBACK_CARDS)) {
    const found = byId.get(hit.id);
    if (found) candidates.push({ slot: candidates.length + 1, kind: "card", id: found.id, title: cap(found.title, 500), excerpt: cap(found.description, EXCERPT_CAP), card: found });
  }
  if (candidates.length === 0) return { jira: [], cards: [] };

  const context: PrLinkContext = {
    pr: { title: cap(pr.title, 500), branch: cap(pr.headRef, 300), body: cap(pr.body ?? "", BODY_CAP), files: input.files.slice(0, FILES_CAP).map((f) => f.slice(0, 300)) },
    candidates: candidates.map(({ slot, kind, id, title, excerpt }) => ({ slot, kind, id, title, excerpt })),
  };
  const answer = await decision.decide(context);
  const match = answer.match as { choice?: unknown; confidence?: unknown } | undefined;
  const slot = typeof match?.choice === "string" ? /^slot(\d+)$/.exec(match.choice) : null;
  const picked = slot ? candidates.find((c) => c.slot === Number(slot[1])) : undefined;
  if (!picked || typeof match?.confidence !== "number") return { jira: [], cards: [] };

  const verdict = applyPolicy(PACKS.pr_link, answer, (await decision.overrides(input.repoPath))).verdicts.match;
  if (verdict === "proceed") {
    return picked.kind === "jira" ? { jira: [{ key: picked.id, how: "decision" }], cards: [] } : { jira: [], cards: [{ card: picked.card!, how: "decision" }] };
  }
  return { jira: [], cards: [], suggestion: { kind: picked.kind, id: picked.id, title: picked.title, confidence: match.confidence, ...(picked.url ? { url: picked.url } : {}) } };
}
