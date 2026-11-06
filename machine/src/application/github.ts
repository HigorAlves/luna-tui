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
  /** Its labels' names, for triage_signals; absent when the adapter did not read them. */
  labels?: string[];
  /** The login that opened it; absent when the adapter did not read it. */
  author?: string;
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

/** One thing someone did on a PR: a conversation comment, a review comment or a review. */
export interface PrActivity {
  /** `comment:<id>`, `review_comment:<id>` or `review:<id>`: stable across polls. */
  id: string;
  kind: "comment" | "review" | "review_comment";
  /** The login, or null for a deleted user. */
  actor: string | null;
  isBot: boolean;
  body: string;
  /** GitHub's `author_association` of whoever did it (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, …); null when GitHub does not say. */
  association: string | null;
  /** A review's state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`); null for a comment. */
  state: string | null;
  at: string;
  url: string | null;
}

/** A submitted review: who, its state, the commit it was given on (when GitHub says) and when. */
import type { ReviewRule } from "../domain/review-rule.ts";

export interface PrReview {
  author: string | null;
  state: string;
  commitId: string | null;
  at: string;
  /** GitHub's `author_association` of the reviewer to the repository (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...); null when GitHub gave none. */
  association: string | null;
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
  /** Merges. `method` is used when the repository allows it, else squash, merge, rebase in that order. With `sha`, GitHub refuses (409) when the head is no
   *  longer that commit. `title` and `message` are the commit's, when given. The head branch goes only with `deleteBranch` (default true: what a merge did before
   *  `ship.merge`). A repo with a merge queue gets the PR enqueued instead (the branch stays) unless `queue` is false, where the refusal is an error.
   *  `sha` of the answer is the merge commit GitHub reports, null when it names none. */
  mergePr(slug: string, number: number, options?: { sha?: string; method?: "squash" | "merge" | "rebase"; queue?: boolean; deleteBranch?: boolean; title?: string; message?: string }): Promise<{ merged: true; sha: string | null } | { queued: true }>;
  /** Deletes a branch of the repository; one that is already gone is not an error. */
  deleteBranch(slug: string, ref: string): Promise<void>;
  /** Puts the PR (by its GraphQL node id) in the repo's merge queue; with `sha`, GitHub refuses when the head is no longer that commit. */
  enqueuePr(nodeId: string, sha?: string): Promise<{ queued: true }>;
  /** A file's text at `ref` (a branch or a commit), or null when it is not there, is not a regular file, or is over 256 KB. */
  fileAtRef(slug: string, ref: string, path: string): Promise<string | null>;
  /** Comments, review comments and reviews on the PR since `since` (null: all), oldest first. */
  prActivity(slug: string, number: number, since: string | null): Promise<PrActivity[]>;
  /** Every submitted review, oldest first. */
  prReviews(slug: string, number: number): Promise<PrReview[]>;
  /** What the repository's own rules ask of a PR into `baseRef`: a ruleset's or the branch protection's required reviews, none, or unreadable (a protected branch whose protection the token cannot read is never `none`). */
  reviewRule(slug: string, baseRef: string): Promise<ReviewRule>;
  /** The logins in `org/<teamSlug>`; throws a GitHubError when the token cannot read the team. */
  teamMembers(org: string, teamSlug: string): Promise<string[]>;
  /** Whether the PR is merged, and its state. */
  prMerged(slug: string, number: number): Promise<{ merged: boolean; mergedSha: string | null; state: "open" | "closed"; mergedAt: string | null }>;
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
  /** Replaces a PR's body. */
  updatePrBody(slug: string, number: number, body: string): Promise<void>;
  /** A PR's conversation comments (not its review comments), every page, with each author's login (null for a deleted user). */
  listPrComments(slug: string, number: number): Promise<Array<{ id: number; body: string; url: string; author: string | null }>>;
  updateComment(slug: string, commentId: number, body: string): Promise<void>;
  /** The head commit of the PR as GitHub sees it, or null when it says none. */
  prHeadSha(slug: string, number: number): Promise<string | null>;
  /** The release named `tag` among the repo's releases, drafts included; created as a draft pre-release when there is none.
   *  A draft has no tag and fires no release event, so no workflow of the repo runs because evidence was published. */
  ensureRelease(slug: string, tag: string, release: { name: string; prerelease: boolean }): Promise<{ id: number; url: string }>;
  releaseAssets(slug: string, releaseId: number): Promise<Array<{ id: number; name: string; url: string }>>;
  /** Uploads a file to a release; `url` is the asset's download url. */
  uploadReleaseAsset(slug: string, releaseId: number, name: string, data: Buffer, contentType: string): Promise<{ url: string }>;
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
    deleteBranch: refuse,
    enqueuePr: refuse,
    fileAtRef: refuse,
    prActivity: refuse,
    prReviews: refuse,
    reviewRule: refuse,
    teamMembers: refuse,
    prMerged: refuse,
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
    updatePrBody: refuse,
    listPrComments: refuse,
    updateComment: refuse,
    prHeadSha: refuse,
    ensureRelease: refuse,
    releaseAssets: refuse,
    uploadReleaseAsset: refuse,
  };
}

/** `error.message` for a GitHubError or anything else thrown. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
