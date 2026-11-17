// Precedents (RFC 0010, "Help agents decide"): a decision pack's own earlier answers on cards like the one in front of it, with what
// really happened, read from the company brain. Opt-in per repository and per pack (`luna.yaml` `brain.precedents`), because it changes
// a pack's input. Anything short of a clean answer is no precedents: a decision never waits on the graph.
import type { PackId, Precedent } from "@hardness/contracts";

import type { PrecedentLookup } from "../domain/stage-input.ts";
import type { Brain } from "./brain.ts";

/** What one pack's input carries at most; the contract allows 8. */
export const PRECEDENTS_MAX = 6;

export interface BrainPrecedentsDeps {
  brain: Brain;
  /** `brain.precedents` of the repository's luna.yaml: the packs that get them. May throw when the file cannot be read. */
  packsOf: (repoPath: string) => Promise<string[]>;
  /** The machine's `repoSlug()`: a precedent is a card of the same repository, `repo:<slug>`, never another's. */
  repoSlug: (repoPath: string) => string;
  log?: (line: string) => void;
}

const text = (value: unknown, cap: number): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, cap) : null);

export function brainPrecedents(deps: BrainPrecedentsDeps): PrecedentLookup {
  const log = deps.log ?? (() => {});
  return async (pack: PackId, title: string, repoPath: string | null, taskId: string | null): Promise<Precedent[]> => {
    if (!deps.brain.enabled || !repoPath) return [];
    try {
      if (!(await deps.packsOf(repoPath)).includes(pack)) return [];
      const slug = deps.repoSlug(repoPath);
      if (!slug) return [];
      const { rows } = await deps.brain.query("precedents", { pack, q: title, repo: `repo:${slug}` });
      const found: Precedent[] = [];
      for (const row of rows) {
        // The card being decided is already in the graph once it has verdicts: they are not precedents for itself.
        if (taskId !== null && row.card === `card:${taskId}`) continue;
        const question = text(row.question, 60);
        const answer = text(row.answer, 60);
        const truth = text(row.truth, 60);
        const card = text(row.title, 200);
        const decidedAt = text(row.decided_at, 40);
        const truthSource = row.truth_source;
        if (!question || !answer || !truth || !card || !decidedAt || (truthSource !== "person" && truthSource !== "outcome")) continue;
        found.push({ question, answer, truth, truthSource, card, decidedAt });
        if (found.length === PRECEDENTS_MAX) break;
      }
      return found;
    } catch (thrown) {
      log(`brain: no precedents for ${pack}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      return [];
    }
  };
}

export interface CardPrecedentsDeps extends BrainPrecedentsDeps {
  /** The card's repository and own title; null when there is no such card. May throw. */
  task: (taskId: string) => Promise<{ repoPath: string | null; title: string } | null>;
}

/** The lookup a decision pack gets. Most packs carry a made-up title ("Red check"), so the search uses the card's own, and the card's repository when the call names none. The card is not loaded while the brain is off. */
export function cardPrecedents(deps: CardPrecedentsDeps): PrecedentLookup {
  const lookup = brainPrecedents(deps);
  return async (pack, title, repoPath, taskId) => {
    if (!deps.brain.enabled) return [];
    const task = taskId ? await deps.task(taskId).catch(() => null) : null;
    return lookup(pack, task?.title || title, repoPath ?? task?.repoPath ?? null, taskId);
  };
}
