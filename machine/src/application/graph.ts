// The code graph the machine keeps per repository: built headlessly from the default branch,
// stamped with the commit it came from, read-only in every stage container.
import type { RequiredOwners } from "../domain/codeowners.ts";
import type { Impact } from "../domain/graph-impact.ts";
import type { Located } from "../domain/graph-locate.ts";

/** What `stamp.json` beside a graph says. */
export interface GraphStamp {
  schema: number;
  /** The default-branch commit the graph was built from. */
  commit: string;
  builtAt: string;
  nodes: number;
  edges: number;
  communities: number;
  graphify: string;
  /** Files tasks changed that the code map did not name, counted from `misses.jsonl` when the graph was built. */
  misses?: number;
}

/** Where in the code a text points: the graph's match plus the default branch's owners and how old the graph is. */
export interface GraphLocation extends Located {
  /** CODEOWNERS at the default branch, for the located files that have owners. */
  owners: RequiredOwners[];
  /** Whether the repo has a CODEOWNERS at the default branch: no owners found means nothing without it. */
  codeowners: boolean;
  /** More than the repo's `graph.stale_commits` commits behind the default branch. */
  stale: boolean;
  /** Commits the default branch has over the graph's; null when it cannot be counted. */
  behind: number | null;
}

export class GraphBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBuildError";
  }
}

export interface Graph {
  /** The stamp of the repo's current graph; null when it has none. */
  stampOf(repoPath: string): Promise<GraphStamp | null>;
  /** The host folder holding the current graph (`graphify-out/`, `stamp.json`); null when none. */
  currentDir(repoPath: string): string | null;
  /** Builds the graph of the default branch's head, unless that commit has one. Throws GraphBuildError. */
  build(repoPath: string, signal?: AbortSignal): Promise<GraphStamp>;
  /** False only when the graph is older than `baseCommit`: its commit is a strict ancestor of it. */
  isFresh(repoPath: string, stamp: GraphStamp, baseCommit: string): Promise<boolean>;
  /** Where `text` points in the repo's code, from the current graph; null when the repo has none. No model. */
  locate(repoPath: string, text: string, options?: { staleCommits?: number }): Promise<GraphLocation | null>;
  /** What a change to `files` reaches (importers, dependents, tests), from the current graph; null when there is none. */
  impact(repoPath: string, files: string[]): Promise<Impact | null>;
  /** Appends the files a task changed that its plan and the code map did not name (accepted by scope_check), one JSON line per call. */
  recordMisses(repoPath: string, miss: GraphMiss): Promise<void>;
}

/** One line of a repo's `misses.jsonl`: where the code map was short. */
export interface GraphMiss {
  task: string;
  at: string;
  files: string[];
}

/** The graph of a machine that builds none: every repo is without one. */
export function noGraph(): Graph {
  return {
    stampOf: async () => null,
    currentDir: () => null,
    build: async () => {
      throw new GraphBuildError("code graphs are off");
    },
    isFresh: async () => true,
    locate: async () => null,
    impact: async () => null,
    recordMisses: async () => {},
  };
}
