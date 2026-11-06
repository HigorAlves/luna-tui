// What a stacked card's PR needs to know of its parent, read from the machine's rows and GitHub's facts (wave 15). A fact is a script:
// a model is never asked whether the parent merged or moved.
import type { GitHub } from "./github.ts";
import type { TaskRow } from "../domain/task.ts";
import { cardOf } from "../domain/card-fields.ts";

/** At most this many times a card's branch is rebased onto a parent that changed, then a person (slice 9). */
export const STACK_REBASES_MAX = 20;

export interface StackFacts {
  parent: { id: string; branch: string; number: number | null; state: "open" | "merged" | "gone"; head: string | null };
  defaultBranch: string | null;
}

export interface StackDeps {
  github: GitHub;
  /** The parent's row. */
  getTask: (id: string) => Promise<TaskRow | null>;
  /** The PR number the parent's last passed `delivering` run named. */
  deliveredNumber: (id: string) => Promise<number | null>;
  /** The default branch, read from GitHub by `slug` (the host fallback is gone): null when it cannot be read. */
  defaultBranch: (repoPath: string, slug?: string) => Promise<string | null>;
  /** Whether the parent card is closed with a merge on record. */
  merged: (id: string) => Promise<boolean>;
}

/**
 * Null for a card with no `card.base`. Else the parent: `merged` only when GitHub says the PR merged into the default branch (or the parent card is
 * closed with a merge on record), `gone` when the card was archived, its PR closed unmerged, or it merged into any other branch, else `open`.
 * A GitHub call that fails throws: the caller waits and never guesses.
 */
export async function stackFactsOf(deps: StackDeps, slug: string, task: TaskRow): Promise<StackFacts | null> {
  const base = cardOf(task).base;
  if (!base) return null;
  const parent = await deps.getTask(base.card);
  const defaultBranch = task.repoPath ? await deps.defaultBranch(task.repoPath, slug).catch(() => null) : null;
  const branch = parent?.branch ?? base.branch;
  const out = (state: "open" | "merged" | "gone", number: number | null, head: string | null): StackFacts => ({ parent: { id: base.card, branch, number, state, head }, defaultBranch });
  if (!parent || parent.state === "archived") return out("gone", null, null);
  if (parent.state === "closed" && (await deps.merged(base.card))) return out("merged", null, null);
  const found = await deps.github.findPr(slug, branch);
  const number = found?.number ?? (await deps.deliveredNumber(base.card));
  if (number === null) return out("gone", null, null);
  const state = await deps.github.prMerged(slug, number);
  if (state.merged) {
    const baseRef = (await deps.github.prFacts(slug, number))?.baseRefName ?? null;
    return out(baseRef !== null && baseRef === defaultBranch ? "merged" : "gone", number, null);
  }
  if (state.state === "closed") return out("gone", number, null);
  return out("open", number, await deps.github.prHeadSha(slug, number));
}

/**
 * For a PR GitHub shows merged: the branch it merged into when that is known and is not the repository's default branch, else null. A merge into any
 * other branch (a stacked card's parent, a branch a person retargeted to) is not a ship. Unreadable is null: nothing here ever invents a branch.
 */
export async function mergedIntoOther(deps: { github: GitHub; stack?: { defaultBranch: (repoPath: string, slug?: string) => Promise<string | null> } }, slug: string, number: number, repoPath: string | null): Promise<string | null> {
  if (!deps.stack || !repoPath) return null;
  const defaultBranch = await deps.stack.defaultBranch(repoPath, slug).catch(() => null);
  // Unknown default branch: fail closed, the merge is not a ship.
  if (!defaultBranch) return "a branch that is not known to be the default";
  const baseRef = (await deps.github.prFacts(slug, number).catch(() => null))?.baseRefName ?? null;
  return baseRef !== null && baseRef !== defaultBranch ? baseRef : null;
}
