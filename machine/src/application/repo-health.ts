// Each repository's image and graph in one row, for `GET /repos` and the board: what runs its stages, when that was built, the graph's commit,
// how far behind it is, which Graphify built it, whether a build is running, and the last failure of either.
import type { RepoHealth } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { GraphStamp } from "./graph.ts";

export interface RepoHealthDeps {
  repos: string[];
  /** The repositories the machine knows now; read on each call, added to `repos`. */
  knownRepos?: () => Promise<string[]>;
  policy: (repoPath: string) => Promise<{ graph?: boolean; factory?: { sandbox?: { image?: { base?: string | null } } } }>;
  machineImage: string;
  images: { pending(repoPath: string): Promise<string | null>; status(repoPath: string): { image: string; builtAt: string | null; lastFailure: string | null } | null };
  graph: { stampOf(repoPath: string): Promise<GraphStamp | null>; health?(repoPath: string): { building: boolean; lastFailure: string | null }; behind?(repoPath: string, commit: string): Promise<number | null> };
  watch: { health(repoPath: string): { building: boolean; lastFailure: string | null } };
}

export async function repoHealthOf(deps: RepoHealthDeps): Promise<RepoHealth[]> {
  const repos = [...new Set([...deps.repos, ...((await deps.knownRepos?.()) ?? [])])];
  return Promise.all(
    repos.map(async (repo): Promise<RepoHealth> => {
      const policy = await deps.policy(repo);
      const base = policy.factory?.sandbox?.image?.base ?? null;
      const own = deps.images.status(repo);
      const pending = await deps.images.pending(repo).catch(() => null);
      const stamp = policy.graph === false ? null : await deps.graph.stampOf(repo).catch(() => null);
      const behind = stamp ? ((await deps.graph.behind?.(repo, stamp.commit).catch(() => null)) ?? null) : null;
      // The graph's own health covers every caller of a build (the watch, a card's readiness wait, a rebuild on merge); the watch adds what is queued and not yet running.
      const watch = deps.watch.health(repo);
      const built = deps.graph.health?.(repo);
      const health = built ? { building: built.building || watch.building, lastFailure: built.lastFailure } : watch;
      return {
        repo,
        image: { inUse: own?.image ?? deps.machineImage, base, builtAt: own?.builtAt ?? null, lastFailure: own?.lastFailure ?? null, pendingBase: pending === null ? null : safe(pending).slice(0, 255) },
        graph: { on: policy.graph !== false, commit: stamp?.commit ?? null, behind, graphify: stamp?.graphify ?? null, builtAt: stamp?.builtAt ?? null, building: health.building, lastFailure: health.lastFailure },
      };
    }),
  );
}
