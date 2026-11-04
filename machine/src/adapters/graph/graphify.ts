// The Graphify adapter of the Graph port. A graph lives at
// `<stateDir>/graphs/<repo-slug>/<commit>/` (`graphify-out/graph.json`, the report, `stamp.json`)
// with a `current` symlink to the newest. A build is a sandbox job on the runner image with the
// entrypoint overridden to `/graph-tools/build.py`, over a clean checkout of the default branch
// mounted read-only; no model, no credential.
import { readlinkSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { GraphBuildError, type Graph, type GraphStamp } from "../../application/graph.ts";
import type { SandboxResult, SandboxRun } from "../docker/docker.ts";
import { ensureCleanCheckout, graphCheckoutPath, headCommit, isAncestor } from "../git/worktree.ts";
import { repoSlug } from "./slug.ts";

const BUILD_TIMEOUT_MS = 15 * 60_000;
/** Commit folders kept per repo: the current graph and two older ones a running stage may still mount. */
export const KEEP_GRAPHS = 3;

export interface GraphGit {
  ensureCleanCheckout(repoPath: string, path: string): Promise<string>;
  headCommit(path: string): Promise<string>;
}

export interface GraphifyDeps {
  stateDir: string;
  image: string;
  worktreesDir: string;
  sandbox: (run: SandboxRun) => Promise<SandboxResult>;
  git?: GraphGit;
}

export function graphifyGraph(deps: GraphifyDeps): Graph {
  const git = deps.git ?? { ensureCleanCheckout, headCommit };
  const dirOf = (repoPath: string) => join(deps.stateDir, "graphs", repoSlug(repoPath));

  async function readStamp(dir: string): Promise<GraphStamp | null> {
    try {
      const stamp = JSON.parse(await readFile(join(dir, "stamp.json"), "utf8")) as GraphStamp;
      return typeof stamp?.commit === "string" ? stamp : null;
    } catch {
      return null;
    }
  }

  function current(repoPath: string): string | null {
    try {
      return join(dirOf(repoPath), readlinkSync(join(dirOf(repoPath), "current")));
    } catch {
      return null;
    }
  }

  async function point(repoDir: string, commit: string): Promise<void> {
    const tmp = join(repoDir, "current.tmp");
    await rm(tmp, { force: true });
    await symlink(commit, tmp);
    await rename(tmp, join(repoDir, "current"));
  }

  /** Drops every commit folder but the `KEEP_GRAPHS` newest: a stage that mounted an older graph may run for a
   *  long time, and the default branch can move more than once meanwhile. */
  async function prune(repoDir: string): Promise<void> {
    const commits = (await readdir(repoDir).catch(() => [])).filter((name) => /^[0-9a-f]{40}$/.test(name));
    const newestFirst = commits.map((name) => ({ name, at: statSync(join(repoDir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const { name } of newestFirst.slice(KEEP_GRAPHS)) await rm(join(repoDir, name), { recursive: true, force: true });
  }

  return {
    async stampOf(repoPath) {
      const dir = current(repoPath);
      return dir ? readStamp(dir) : null;
    },

    currentDir(repoPath) {
      return current(repoPath);
    },

    async build(repoPath, signal) {
      const repoDir = dirOf(repoPath);
      const checkout = await git.ensureCleanCheckout(repoPath, graphCheckoutPath(repoSlug(repoPath), deps.worktreesDir));
      const commit = await git.headCommit(checkout);
      const target = join(repoDir, commit);
      const have = await readStamp(target);
      if (have) {
        const previous = current(repoPath);
        if (previous !== target) await point(repoDir, commit);
        return have;
      }
      const building = join(repoDir, `building-${commit}`);
      await rm(building, { recursive: true, force: true });
      await mkdir(building, { recursive: true });
      let result: SandboxResult;
      try {
        result = await deps.sandbox({
          name: `luna-graph-${repoSlug(repoPath)}`,
          image: deps.image,
          runDir: join(repoDir, "run"),
          worktree: checkout,
          writable: false,
          gitDir: null,
          input: {},
          timeoutMs: BUILD_TIMEOUT_MS,
          credential: { env: {}, mounts: [] },
          labels: { luna: "graph", "luna.repo": repoSlug(repoPath) },
          mounts: [{ host: building, container: "/graph", readOnly: false }],
          entrypoint: ["python3", "/graph-tools/build.py", "--input", "/work", "--out", "/graph", "--commit", commit],
          // Parsing untrusted code needs no network at all.
          networkNone: true,
          signal,
        });
      } catch (error) {
        await rm(building, { recursive: true, force: true });
        throw new GraphBuildError(`the graph build did not run: ${(error as Error).message}`);
      }
      const stamp = result.exitCode === 0 ? await readStamp(building) : null;
      if (!stamp) {
        await rm(building, { recursive: true, force: true });
        const why = result.timedOut ? "timed out" : result.aborted ? "aborted" : `exit code ${result.exitCode}`;
        throw new GraphBuildError(`the graph build of ${commit.slice(0, 7)} failed (${why})`);
      }
      await rm(target, { recursive: true, force: true });
      await rename(building, target);
      await point(repoDir, commit);
      await prune(repoDir);
      return stamp;
    },

    async recordMisses(repoPath, miss) {
      await mkdir(dirOf(repoPath), { recursive: true });
      await appendFile(join(dirOf(repoPath), "misses.jsonl"), `${JSON.stringify(miss)}\n`);
    },

    async isFresh(repoPath, stamp, baseCommit) {
      if (stamp.commit === baseCommit) return true;
      return !(await isAncestor(repoPath, stamp.commit, baseCommit));
    },
  };
}
