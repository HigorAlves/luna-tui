// A pull request as the inbox shows it: the GraphQL node the host fetched, mapped to the
// board's shape and placed in one split. Pure: no I/O, so every rule is unit tested.
import type { ChecksState, PrCheck, PrSplit, PullRequest } from "@hardness/contracts";

/** One GraphQL query per PR: everything the inbox needs about it. Variables: owner, name, number. */
export const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    number title body url isDraft updatedAt baseRefName headRefName
    author{login} headRepository{nameWithOwner}
    reviewDecision mergeable mergeStateStatus
    reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug}}}}
    reviewThreads(first:100){nodes{isResolved}}
    commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename
      ... on CheckRun{name status conclusion detailsUrl}
      ... on StatusContext{context state targetUrl}}}}}}}
  } } }`;

export interface CheckRunNode {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface StatusContextNode {
  __typename: "StatusContext";
  context: string;
  state: string;
  targetUrl: string | null;
}

/** The `pullRequest` object `PR_QUERY` answers with. */
export interface PrNode {
  number: number;
  title: string;
  /** Absent from older fixtures; the review pack reads it. */
  body?: string | null;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  author: { login: string } | null;
  /** Null when the fork the head lived in was deleted. */
  headRepository: { nameWithOwner: string } | null;
  reviewDecision: PullRequest["reviewDecision"];
  mergeable: PullRequest["mergeable"];
  /** Absent from older fixtures. */
  mergeStateStatus?: PullRequest["mergeState"] | null;
  reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string; slug?: string } | null }> };
  reviewThreads: { nodes: Array<{ isResolved: boolean }> };
  commits: {
    nodes: Array<{
      commit: { statusCheckRollup: { state: string; contexts: { nodes: Array<CheckRunNode | StatusContextNode> } } | null };
    }>;
  };
}

/** Everything about a PR but what the machine adds on top (its split, checkout and task). */
export type PrFacts = Omit<PullRequest, "split" | "localPath" | "task">;

const RUN_FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const STATUS_FAILED = new Set(["FAILURE", "ERROR"]);

type Verdict = "passed" | "failed" | "pending";

function verdictOf(node: CheckRunNode | StatusContextNode): { check: PrCheck; verdict: Verdict } {
  if (node.__typename === "StatusContext") {
    const state = node.state.toUpperCase();
    const verdict: Verdict = state === "SUCCESS" ? "passed" : STATUS_FAILED.has(state) ? "failed" : "pending";
    return { check: { name: node.context, state: node.state, url: node.targetUrl }, verdict };
  }
  const conclusion = (node.conclusion ?? "").toUpperCase();
  const verdict: Verdict =
    node.status.toUpperCase() !== "COMPLETED" ? "pending" : RUN_FAILED.has(conclusion) ? "failed" : "passed";
  return { check: { name: node.name, state: node.conclusion ?? node.status, url: node.detailsUrl }, verdict };
}

/** The checks rolled up: `none` when the PR has no checks at all. */
export function summarizeChecks(nodes: Array<CheckRunNode | StatusContextNode>): PullRequest["checks"] {
  let passed = 0;
  let pending = 0;
  const failed: PrCheck[] = [];
  const all: PrCheck[] = [];
  for (const node of nodes) {
    const { check, verdict } = verdictOf(node);
    all.push(check);
    if (verdict === "passed") passed++;
    else if (verdict === "failed") failed.push(check);
    else pending++;
  }
  const state: ChecksState = nodes.length === 0 ? "none" : failed.length > 0 ? "failure" : pending > 0 ? "pending" : "success";
  return { state, passed, total: nodes.length, failed, all };
}

/** Maps the node `PR_QUERY` answered for `repo` (`owner/name`) to the inbox's facts about it. */
export function fromGraphQl(node: PrNode, repo: string, me: string, teams: string[]): PrFacts {
  const author = node.author?.login ?? "ghost";
  const teamSet = new Set(teams.map((t) => t.toLowerCase()));
  const reviewRequested = node.reviewRequests.nodes.some((r) => {
    const who = r.requestedReviewer;
    if (!who) return false;
    if (who.login) return who.login.toLowerCase() === me.toLowerCase();
    return who.slug !== undefined && teamSet.has(who.slug.toLowerCase());
  });
  const head = node.headRepository?.nameWithOwner ?? null;
  return {
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    author,
    mine: author.toLowerCase() === me.toLowerCase(),
    reviewRequested,
    isDraft: node.isDraft,
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    fromFork: head === null || head.toLowerCase() !== repo.toLowerCase(),
    reviewDecision: node.reviewDecision ?? null,
    mergeable: node.mergeable ?? "UNKNOWN",
    mergeState: node.mergeStateStatus ?? "UNKNOWN",
    checks: summarizeChecks(node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []),
    unresolvedThreads: node.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    updatedAt: node.updatedAt,
  };
}

/** GitHub's own answer decides whether the Merge button works: CLEAN, HAS_HOOKS or UNSTABLE (only
 *  checks that are not required are red). Only while GitHub has not said yet does the rule below
 *  stand in: approved (or the repo asks for no review, which GitHub reports as no decision at all),
 *  green (or no checks), mergeable, not a draft, nothing left to resolve. */
export function readyToMerge(pr: PrFacts): boolean {
  if (pr.isDraft) return false;
  if (pr.mergeState === "CLEAN" || pr.mergeState === "HAS_HOOKS") return true;
  // Mergeable with a check that is not required still red or running: red is CI failed, running is not ready yet.
  if (pr.mergeState === "UNSTABLE") return pr.checks.state !== "pending";
  if (pr.mergeState !== "UNKNOWN") return false;
  return (
    (pr.reviewDecision === "APPROVED" || pr.reviewDecision === null) &&
    (pr.checks.state === "success" || pr.checks.state === "none") &&
    pr.mergeable === "MERGEABLE" &&
    !pr.isDraft &&
    pr.unresolvedThreads === 0
  );
}

/**
 * The one split a PR lands in. A teammate's PR is Review requested or nothing; your own
 * runs CI failed > Changes requested > Ready to merge > CI running > Mine.
 */
export function splitOf(pr: PrFacts): PrSplit {
  if (!pr.mine) return pr.reviewRequested ? "review_requested" : "mine";
  if (pr.checks.state === "failure") return "ci_failed";
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.unresolvedThreads > 0) return "changes_requested";
  if (readyToMerge(pr)) return "ready_to_merge";
  if (pr.checks.state === "pending") return "ci_running";
  return "mine";
}

/** The splits that count on the board's badge and raise a notice. */
export const needsMe = (split: PrSplit): boolean => split !== "mine" && split !== "ci_running";

/** Whether the machine can push a fix to this PR's branch: a checkout, and not a fork. */
export const canPush = (pr: Pick<PullRequest, "fromFork" | "localPath">): boolean => !pr.fromFork && pr.localPath !== null;
