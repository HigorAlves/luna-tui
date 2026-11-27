// The GitHub PR inbox: every open PR involving you, as the machine polls it and the board
// shows it. The machine classifies; the board only reads `split`.
import { z } from "zod";

/** Where a PR sits for you. One split per PR, picked by the machine's `splitOf`. */
export const PrSplit = z.enum(["review_requested", "ready_to_merge", "ci_failed", "ci_running", "changes_requested", "mine"]);
export type PrSplit = z.infer<typeof PrSplit>;

export const ChecksState = z.enum(["none", "pending", "success", "failure"]);
export type ChecksState = z.infer<typeof ChecksState>;

export interface PrCheck {
  name: string;
  state: string;
  url: string | null;
}

/** What you can ask the machine to do about a PR. */
export const PrAction = z.enum(["ci_fix", "review", "address"]);
export type PrAction = z.infer<typeof PrAction>;

/** What a PR's menu can do, in its order: three start a PR task, Merge and Close run on the machine. */
export const PrMenuAction = z.enum(["ci_fix", "address", "review", "merge", "close"]);
export type PrMenuAction = z.infer<typeof PrMenuAction>;

/** One action on one PR as a client shows it: greyed with the machine's reason, so a greyed one never round-trips to learn it would be refused. */
export interface PrActionState {
  action: PrMenuAction;
  /** True exactly when `reason` is null. */
  allowed: boolean;
  /** Why it can't run, in words for a person ("a check is red", "GitHub: still a draft"); null when it can. */
  reason: string | null;
  /** Off only for want of a checkout: a clone is all it needs. */
  needsClone: boolean;
}

/** One open PR involving you. */
export interface PullRequest {
  /** `owner/name` */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** GitHub's `author_association` of the author (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, …); absent from a source that does not say. A card made from the PR keeps it for its trust. */
  authorAssociation?: string | null;
  /** You authored it. */
  mine: boolean;
  /** Your review is requested, directly or through a team. */
  reviewRequested: boolean;
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  /** The head lives in a fork: the machine cannot push to it. */
  fromFork: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's own verdict on merging now: CLEAN, HAS_HOOKS and UNSTABLE can; BLOCKED (a rule still waits), BEHIND, DIRTY (conflicts) and DRAFT cannot; UNKNOWN while it computes. */
  mergeState: "CLEAN" | "HAS_HOOKS" | "UNSTABLE" | "BLOCKED" | "BEHIND" | "DIRTY" | "DRAFT" | "UNKNOWN";
  /** `failed` is the red subset of `all`, which lists every check in the order GitHub reports them. */
  checks: { state: ChecksState; passed: number; total: number; failed: PrCheck[]; all: PrCheck[] };
  unresolvedThreads: number;
  split: PrSplit;
  /** The checkout the machine would act in; null means read-only until cloned. */
  localPath: string | null;
  /** The PR task in flight for this PR, if any. */
  task: { id: string; state: string; route: PrAction } | null;
  updatedAt: string;
  /** When it was opened; its last update for a source that does not say. */
  createdAt: string;
  /** When your review (or a team's you are in) was last asked; null when it was not. Waiting is counted from here for a review. */
  reviewRequestedAt: string | null;
  /** Every review thread was read; false when GitHub counts more than the query listed, so `unresolvedThreads` may be short. */
  threadsComplete: boolean;
  /** Each menu action and why it can't run, worked out by the machine (`actionsOf`). */
  actions: PrActionState[];
  /** The head commit and its date; null from sources that do not say (older fixtures). */
  headSha: string | null;
  headCommittedAt: string | null;
  /** The GraphQL node id, for the merge queue. */
  nodeId: string | null;
  /** The PR's description; Ship reads `Depends on #N` from it. */
  body: string | null;
}

/** `GET /github/prs` and the `github.prs` stream event: the PRs that involve you (yours and those asking your review).
 *  `GET /github/prs/all` and the `github.prs.all` event carry the same shape for every open PR in the repos you can reach
 *  (owned, collaborator, organisation member): `split` is computed the same way, so a board can show either list. */
export interface PrSnapshot {
  prs: PullRequest[];
  polledAt: string | null;
  error: string | null;
  /** One line of what waits on you ("2 PRs are waiting for your review · 1 is ready to merge"); null when nothing does. Absent from the all-list and an older machine. */
  digest?: string | null;
  /** The clones the machine is running or ran lately (done and failed ones stay ten minutes), in both lists; absent from an older machine. */
  clones?: CloneStatus[];
}

/** What changed in the inbox that a client may say out loud. */
export const PrActivityKind = z.enum(["review_requested", "checks_failed", "checks_passed", "ready_to_merge", "changes_requested"]);
export type PrActivityKind = z.infer<typeof PrActivityKind>;

/** One change between two polls of the inbox (`github.activity`). The machine notices; a client decides when to say it. */
export interface PrActivity {
  kind: PrActivityKind;
  /** `owner/name` */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** When the poll that saw it ended. */
  at: string;
}

/** One `git clone` the board asked for. A failed one keeps its `error` here, since a poll rewrites the snapshot's own. */
export interface CloneStatus {
  /** `owner/name` */
  repo: string;
  /** The folder being made. */
  dest: string;
  state: "cloning" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** Everything about a PR but what the machine adds for the inbox (its split, checkout, task and menu). */
export type PrFacts = Omit<PullRequest, "split" | "localPath" | "task" | "actions">;

/** One review thread on a PR, resolved ones included. */
export interface PrThread {
  id: string;
  path: string | null;
  /** Null once the code has moved on (`outdated`). */
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: Array<{ author: string; body: string; at: string }>;
}

/** `GET /github/prs/{owner}/{name}/{number}`: one PR read now, for a client's PR tab. */
export interface PrDetail {
  /** `owner/name` */
  repo: string;
  number: number;
  state: "open" | "closed" | "merged";
  facts: PrFacts;
  threads: PrThread[];
  reviews: Array<{ author: string | null; state: string; at: string }>;
  files: Array<{ path: string; additions: number; deletions: number; previousPath?: string }>;
}

/** A PR by its link: what lookup and open answer. */
export interface PrLink {
  url: string;
  number: number;
  isDraft: boolean;
}

/** One PR or issue a search found. */
export interface IssueHit {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  author: string | null;
}

export const IssueKind = z.enum(["pr", "issue"]);
export type IssueKind = z.infer<typeof IssueKind>;

/** `POST /github/pr`: push a branch of a checkout under the machine's repositories folder and open its PR. */
export const OpenPrInput = z.object({
  path: z.string().min(1),
  branch: z.string().min(1).max(255).regex(/^[\w./-]+$/, "branch: letters, digits, . _ / - only"),
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).default(""),
  base: z.string().min(1).max(255).optional(),
  draft: z.boolean().default(false),
});
export type OpenPrInput = z.infer<typeof OpenPrInput>;

export const PrActionInput = z.object({ action: PrAction });
export type PrActionInput = z.infer<typeof PrActionInput>;

export const MergeInput = z.object({ method: z.enum(["squash"]).default("squash") });
export type MergeInput = z.infer<typeof MergeInput>;

export const CloneInput = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
  dest: z.string().min(1),
});
export type CloneInput = z.infer<typeof CloneInput>;
