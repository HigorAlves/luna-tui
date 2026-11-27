// The GitHub port: everything the machine asks GitHub, as typed calls. The Octokit adapter
// implements it; tests pass a fake. Pushing and cloning stay git on the host (your own
// credentials), so they are not here. Every method throws a `GitHubError` with GitHub's own
// words when a call fails; callers that report instead of throwing catch it.
import type { ReviewContext, ThreadsContext } from "@hardness/contracts";

import type { PrNode } from "../domain/pull-request.ts";

export class GitHubError extends Error {
  /** GitHub's HTTP status when GitHub itself refused; absent for a failure the machine raised. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
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

/** Every open PR in the repos you can reach, each with the node the per-PR query answers (its nested lists may be shorter), read in as few calls as GitHub allows. */
export interface OpenPrs {
  prs: Array<{ repo: string; node: PrNode }>;
  /** Repos with more open PRs than the adapter pages through: `open` in all, the rest are not seen. */
  capped: Array<{ repo: string; open: number }>;
  /** How many GraphQL calls the read took, for the poll's log line. */
  calls: number;
  /** Repos GitHub refused to read even alone (too heavy, a 5xx): left out of the list, named here so the poll says so. */
  skipped?: Array<{ repo: string; error: string }>;
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
  /** GitHub's `author_association` of whoever opened it; absent when the adapter did not read it (the card then counts as untrusted). */
  authorAssociation?: string;
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
  /** The branch the PR targets; absent, the repository's default branch. A stacked card's PR targets its parent's branch. */
  base?: string;
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

/** A PR merged in a window, with the facts a change record is computed from. */
export interface MergedPr {
  number: number;
  title: string;
  url: string;
  body: string;
  author: string | null;
  mergedBy: string | null;
  mergedAt: string;
  mergeSha: string | null;
  baseRef: string;
  headRef: string;
  /** The PR's last commit; null when GitHub names none. */
  headSha: string | null;
  closingIssues: Array<{ number: number; url: string }>;
  reviews: Array<{ author: string | null; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"; commitId: string | null; submittedAt: string | null }>;
}

/** A push a ruleset evaluated and let through because the actor may bypass it. */
export interface RuleBypass {
  /** `refs/heads/<branch>` */
  ref: string;
  actor: string | null;
  at: string;
  afterSha: string | null;
  ruleSuiteId: number;
}

export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read";

/** One bypass entry of a repository's ruleset (its own or one inherited from the org). */
export interface RulesetBypassActor {
  ruleset: string;
  /** GitHub's `actor_type`: `Team`, `Integration`, `RepositoryRole`, `OrganizationAdmin`, `DeployKey`. */
  actorType: string;
  actorId: number | null;
  actorName: string | null;
  /** `always` or `pull_request` (GitHub's `bypass_mode`). */
  mode: string;
}

export type AlertSeverity = "critical" | "high" | "medium" | "low";

/** An open Dependabot alert. */
export interface DependabotAlert {
  number: number;
  package: string;
  ecosystem: string;
  severity: AlertSeverity;
  manifestPath: string;
  vulnerableRange: string;
  /** The first version that fixes it; null when none does yet. */
  patchedVersion: string | null;
  ghsa: string;
  cve: string | null;
  summary: string;
  url: string;
  createdAt: string;
}

/** An open code-scanning alert. */
export interface CodeScanningAlert {
  number: number;
  rule: string;
  severity: AlertSeverity;
  tool: string;
  path: string;
  url: string;
  createdAt: string;
}

export interface GitHub {
  /** Who the token belongs to, and the slugs of their teams (empty when the token cannot read them). */
  viewer(): Promise<{ login: string; teams: string[] }>;
  /** Every open PR you authored or were asked to review, deduped. */
  searchMyPrs(): Promise<PrSearchHit[]>;
  /** Every open PR in the repos you own, collaborate on or reach through an organisation (archived repos skipped), newest first within a repo, read in bulk: one call covers many repos and PRs. */
  listOpenPrs(): Promise<OpenPrs>;
  /** The PR's node for the inbox query, or null when GitHub no longer shows it. */
  prFacts(slug: string, number: number): Promise<PrNode | null>;
  /** The unified diff, whole; GitHub refuses one over 20,000 lines (the review reads those with host git). */
  prDiff(slug: string, number: number): Promise<string>;
  prFiles(slug: string, number: number): Promise<ReviewContext["files"]>;
  prComments(slug: string, number: number): Promise<ReviewContext["existingComments"]>;
  /** The unresolved review threads, with the ids replies and resolutions address; `includeResolved` keeps the resolved ones too (each says `resolved`). */
  prThreads(slug: string, number: number, options?: { includeResolved?: boolean }): Promise<ThreadsContext["threads"]>;
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
  /** GitHub's `author_association` of whoever opened one issue; null when GitHub gives none. Rejects when the read fails. */
  issueAssociation(slug: string, number: number): Promise<string | null>;
  commentOnIssue(slug: string, number: number, body: string): Promise<void>;
  /** Opens a new issue in `slug` (a split's child ticket). A write: only on a person's tap. */
  /** The repository's default branch as GitHub says it, or null when it cannot be read. */
  defaultBranch(slug: string): Promise<string | null>;
  /** Whether GitHub reports the repository private; null when it cannot be read. */
  repoPrivate(slug: string): Promise<boolean | null>;
  createIssue(slug: string, issue: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }>;
  /** The open PR whose head is `branch`, or null. */
  findPr(slug: string, branch: string): Promise<PrRef | null>;
  openPr(slug: string, pr: NewPr): Promise<PrRef>;
  /** Changes the branch an open PR targets (a stacked card's PR, once its parent merged). */
  retargetPr(slug: string, number: number, base: string): Promise<void>;
  markPrReady(slug: string, number: number): Promise<void>;
  /** The PRs of `slug` merged between `since` and `until` (ISO, inclusive), oldest first. */
  mergedPrs(slug: string, since: string, until: string): Promise<MergedPr[]>;
  /** The ruleset evaluations of `slug` that ended in a bypass in the window; "unknown" when the token cannot read rule suites (403 or 404). */
  ruleBypasses(slug: string, since: string, until: string): Promise<RuleBypass[] | "unknown">;
  /** The org's members with their role, owners and members, every page. */
  orgMembers(org: string): Promise<Array<{ login: string; role: "admin" | "member" }>>;
  outsideCollaborators(org: string): Promise<Array<{ login: string }>>;
  /** The org's pending invitations (an invitee is a login or an email). */
  orgInvitations(org: string): Promise<Array<{ login: string | null; email: string | null; role: string; createdAt: string; inviter: string | null }>>;
  /** Everyone with access to the repository and their permission; `direct` is false for access that comes through an org role or a team. */
  repoCollaborators(slug: string): Promise<Array<{ login: string; permission: RepoPermission; direct: boolean }>>;
  /** Who may bypass the repository's rulesets; "unknown" when the token cannot read them (403 or 404). */
  rulesetBypassActors(slug: string): Promise<RulesetBypassActor[] | "unknown">;
  /** Whether branch protection on `branch` applies to admins too; "unknown" when the token cannot read it. */
  adminsEnforced(slug: string, branch: string): Promise<boolean | "unknown">;
  /** Whether each login made any contribution to the org's repos since `since` (ISO); a login GitHub does not know is false. */
  memberActivity(org: string, logins: string[], since: string): Promise<Map<string, boolean>>;
  /** The open Dependabot alerts of `slug`; "unknown" when the token cannot read them (403 or 404). */
  dependabotAlerts(slug: string): Promise<DependabotAlert[] | "unknown">;
  /** The open code-scanning alerts of `slug`; "unknown" when the token cannot read them (403 or 404). */
  codeScanningAlerts(slug: string): Promise<CodeScanningAlert[] | "unknown">;
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
  /** Replaces a release's body. */
  updateReleaseBody(slug: string, releaseId: number, body: string): Promise<void>;
  /** The latest published release (never a draft or a pre-release), or null when the repo has none. */
  latestRelease(slug: string): Promise<{ tag: string; publishedAt: string } | null>;
  /** The published releases (never a draft), newest first; the first page only. */
  recentReleases(slug: string): Promise<Array<{ tag: string; publishedAt: string }>>;
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
    listOpenPrs: refuse,
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
    issueAssociation: refuse,
    commentOnIssue: refuse,
    defaultBranch: async () => null,
    repoPrivate: async () => null,
    createIssue: refuse,
    findPr: refuse,
    openPr: refuse,
    retargetPr: refuse,
    markPrReady: refuse,
    mergedPrs: refuse,
    ruleBypasses: refuse,
    orgMembers: refuse,
    outsideCollaborators: refuse,
    orgInvitations: refuse,
    repoCollaborators: refuse,
    rulesetBypassActors: refuse,
    adminsEnforced: refuse,
    memberActivity: refuse,
    prChecks: refuse,
    failedRunLog: refuse,
    rerunFailedJobs: refuse,
    updatePrBody: refuse,
    listPrComments: refuse,
    updateComment: refuse,
    prHeadSha: refuse,
    ensureRelease: refuse,
    releaseAssets: refuse,
    updateReleaseBody: refuse,
    latestRelease: refuse,
    recentReleases: refuse,
    dependabotAlerts: refuse,
    codeScanningAlerts: refuse,
    uploadReleaseAsset: refuse,
  };
}

/** `error.message` for a GitHubError or anything else thrown. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
