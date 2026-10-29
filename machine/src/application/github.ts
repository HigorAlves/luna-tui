// The GitHub port: everything the machine asks GitHub, as typed calls. The Octokit adapter
// implements it; tests pass a fake. Pushing and cloning stay git on the host (your own
// credentials), so they are not here. Every method throws a `GitHubError` with GitHub's own
// words when a call fails; callers that report instead of throwing catch it.
import type { ReviewContext, ThreadsContext } from "@hardness/contracts";

import type { PrNode } from "../domain/pull-request.ts";

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/** `owner/name` split once, at the boundary. */
export interface RepoRef {
  owner: string;
  repo: string;
}

export function repoRef(slug: string): RepoRef {
  const [owner = "", repo = ""] = slug.split("/");
  if (!owner || !repo) throw new GitHubError(`not an owner/name repo: "${slug}"`);
  return { owner, repo };
}

export interface PrRef {
  url: string;
  number: number;
  isDraft: boolean;
}

export interface PrSearchHit {
  /** `owner/name` */
  repo: string;
  number: number;
  updatedAt: string;
}

/** One check on a ref, in the states ci_watch keys on (uppercase, GitHub's own vocabulary). */
export interface Check {
  name: string;
  state: string;
  link: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
}

export interface ReviewPost {
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; body: string }>;
}

export interface NewPr {
  title: string;
  body: string;
  head: string;
  draft: boolean;
}

export interface GitHub {
  /** Who the token belongs to, and the slugs of their teams (empty when the token cannot read them). */
  viewer(): Promise<{ login: string; teams: string[] }>;
  /** Every open PR you authored or were asked to review, deduped. */
  searchMyPrs(): Promise<PrSearchHit[]>;
  /** The PR's node for the inbox query, or null when GitHub no longer shows it. */
  prFacts(slug: string, number: number): Promise<PrNode | null>;
  /** The unified diff, tail-capped by the adapter. */
  prDiff(slug: string, number: number): Promise<string>;
  prFiles(slug: string, number: number): Promise<ReviewContext["files"]>;
  prComments(slug: string, number: number): Promise<ReviewContext["existingComments"]>;
  /** The unresolved review threads, with the ids replies and resolutions address. */
  prThreads(slug: string, number: number): Promise<ThreadsContext["threads"]>;
  /** Merges the way the repo allows (squash, else merge, else rebase) and deletes the head branch. */
  mergePr(slug: string, number: number): Promise<void>;
  /** Closes the PR without merging; its branch stays. */
  closePr(slug: string, number: number): Promise<void>;
  postReview(slug: string, number: number, review: ReviewPost): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  /** Whether someone resolved the thread meanwhile; false when GitHub cannot say. */
  threadResolved(threadId: string): Promise<boolean>;
  /** Open issues (not PRs) carrying `label`. */
  listReadyIssues(slug: string, label: string): Promise<GhIssue[]>;
  commentOnIssue(slug: string, number: number, body: string): Promise<void>;
  /** The open PR whose head is `branch`, or null. */
  findPr(slug: string, branch: string): Promise<PrRef | null>;
  openPr(slug: string, pr: NewPr): Promise<PrRef>;
  markPrReady(slug: string, number: number): Promise<void>;
  /** Every check run and commit status on `ref`. */
  prChecks(slug: string, ref: string): Promise<Check[]>;
  /** The failed jobs' logs of a workflow run, joined. */
  failedRunLog(slug: string, runId: string): Promise<string>;
  rerunFailedJobs(slug: string, runId: string): Promise<void>;
}

const NO_TOKEN = "no GitHub token: set GITHUB_TOKEN (or GH_TOKEN) for the machine";

/** The port with no token behind it: every call fails with the same clear reason. */
export function noTokenGitHub(): GitHub {
  const refuse = () => Promise.reject(new GitHubError(NO_TOKEN));
  return {
    viewer: refuse,
    searchMyPrs: refuse,
    prFacts: refuse,
    prDiff: refuse,
    prFiles: refuse,
    prComments: refuse,
    prThreads: refuse,
    mergePr: refuse,
    closePr: refuse,
    postReview: refuse,
    replyToThread: refuse,
    resolveThread: refuse,
    threadResolved: () => Promise.resolve(false),
    listReadyIssues: refuse,
    commentOnIssue: refuse,
    findPr: refuse,
    openPr: refuse,
    markPrReady: refuse,
    prChecks: refuse,
    failedRunLog: refuse,
    rerunFailedJobs: refuse,
  };
}

/** `error.message` for a GitHubError or anything else thrown. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
