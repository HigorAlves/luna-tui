// The code graph the machine keeps per repository: built headlessly from the default branch,
// stamped with the commit it came from, read-only in every stage container.

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
    recordMisses: async () => {},
  };
}
