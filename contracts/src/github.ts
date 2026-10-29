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

/** One open PR involving you. */
export interface PullRequest {
  /** `owner/name` */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
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
}

/** `GET /github/prs` and the `github.prs` stream event. */
export interface PrSnapshot {
  prs: PullRequest[];
  polledAt: string | null;
  error: string | null;
}

export const PrActionInput = z.object({ action: PrAction });
export type PrActionInput = z.infer<typeof PrActionInput>;

export const MergeInput = z.object({ method: z.enum(["squash"]).default("squash") });
export type MergeInput = z.infer<typeof MergeInput>;

export const CloneInput = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
  dest: z.string().min(1),
});
export type CloneInput = z.infer<typeof CloneInput>;
