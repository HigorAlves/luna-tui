// What a repo's own runs say about each pack: how often it escalated or got stuck, and what it cost. A port only; the
// config proposal reads it. The adapter that backs it comes with the signals query (a later slice).
import type { PackId } from "@hardness/contracts";

import type { RepoSignal } from "../domain/config-proposal.ts";

export interface RepoSignals {
  /** Per pack, the repo's runs from `since` on. A pack with no runs is left out. */
  forRepo(repo: string, since: Date): Promise<Partial<Record<PackId, RepoSignal>>>;
}

/** No signals: every repo looks quiet, so `POST /repos/proposals` finds no change until an adapter backs the port. */
export function noRepoSignals(): RepoSignals {
  return { forRepo: async () => ({}) };
}
