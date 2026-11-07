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
  /** The id of the image the graph was built in (the repository's own); absent on a graph built before wave 11b. */
  image?: string;
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

/** The graph of a card's newest slice commit: the host folder (`graphify-out/`, `stamp.json`) and its stamp. */
export interface BranchGraph {
  dir: string;
  stamp: GraphStamp;
}

/** What a branch build came to. Never an error: a card goes on with the previous branch graph or the main one. */
export type BranchBuild =
  | { state: "built"; stamp: GraphStamp; mode: "full" | "incremental" }
  | { state: "skipped"; reason: string }
  | { state: "failed"; reason: string };

export interface BranchBuildInput {
  repoPath: string;
  taskId: string;
  /** The card's workspace folder `W`: it only names the card's machine-owned repository `M`; nothing is read from it. */
  workspacePath: string;
  /** The slice commit the machine accepted. */
  commit: string;
  /** `graph.branch_build_minutes`: a build running longer is stopped. */
  minutes: number;
}

export interface Graph {
  /** The stamp of the repo's current graph; null when it has none. */
  stampOf(repoPath: string): Promise<GraphStamp | null>;
  /** The host folder holding the current graph (`graphify-out/`, `stamp.json`); null when none. */
  currentDir(repoPath: string): string | null;
  /** Builds the graph of the default branch's head, unless that commit has one. Throws GraphBuildError. */
  build(repoPath: string, signal?: AbortSignal): Promise<GraphStamp>;
  /** Whether a build of this repository is running now (whoever asked for it) and the last one's failure, flattened and capped. */
  health?(repoPath: string): { building: boolean; lastFailure: string | null };
  /** False when the graph is older than `baseCommit`: its commit is a strict ancestor of it. */
  isFresh(repoPath: string, stamp: GraphStamp, baseCommit: string): Promise<boolean>;
  /** Commits the default branch has over `commit`; null when they cannot be counted. */
  behind?(repoPath: string, commit: string): Promise<number | null>;
  /** Where `text` points in the repo's code, from the current graph; null when the repo has none. No model. */
  locate(repoPath: string, text: string, options?: { staleCommits?: number }): Promise<GraphLocation | null>;
  /** Who owns `paths` at the default branch (CODEOWNERS), for any plain repo-relative paths whether or not the graph knows them; null when the repo has no graph. */
  owners(repoPath: string, paths: string[]): Promise<{ owners: RequiredOwners[]; codeowners: boolean; dropped?: number } | null>;
  /** What a change to `files` reaches (importers, dependents, tests), from the current graph; null when there is none. */
  impact(repoPath: string, files: string[]): Promise<Impact | null>;
  /** The files earlier cards declared outside the map and the machine accepted, most frequent first, at most twenty, plain repository paths. */
  pastMisses?(repoPath: string): Promise<string[]>;
  /**
   * Builds the graph of a card's accepted slice commit from a clean export of it out of the card's own repository (never from `W`),
   * under `<graphs>/<repo>/cards/<task>/<commit>/`, incrementally from the previous commit's graph when there is one. Only when the
   * repository has a main graph. Commits queued for one card build only the newest. Resolves; a failure leaves the previous graph.
   */
  buildBranch?(input: BranchBuildInput): Promise<BranchBuild>;
  /** The card's newest branch graph; null when it has none. */
  branchGraph?(repoPath: string, taskId: string): Promise<BranchGraph | null>;
  /** Deletes every branch graph of a card (it was closed or removed); a build still running for it leaves nothing behind. */
  dropBranch?(repoPath: string, taskId: string): Promise<void>;
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
    owners: async () => null,
    recordMisses: async () => {},
  };
}
