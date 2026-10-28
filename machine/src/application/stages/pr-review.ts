// The reviewing stage of a review PR task: the host fetches the PR's diff, files and the
// comments already on it (the sandbox has no gh credential), the pr-reviewer pack answers
// with line-anchored comments and a verdict, and the host posts one COMMENT review at once.
// An approve / request-changes verdict waits at the gate; `postVerdictRunner` posts it on `a`.
import { PrReviewAnswer, type RequestedAction, type ReviewContext } from "@hardness/contracts";

import { type Gh, defaultGh, postReview, prComments, prDiff, prFacts, prFiles } from "../../adapters/github/gh.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

export interface PrReviewDeps {
  gh?: Gh;
  /** Runs the reviewing pack with what the host fetched. */
  runPack: (context: StageContext, review: ReviewContext) => Promise<StageResult>;
}

const EVENT_OF = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;

/** inline-review's cap: more than this erodes signal, so the lowest severities stay in findings only. */
export const MAX_INLINE_COMMENTS = 15;
const SEVERITY_RANK: Record<string, number> = { security: 0, bug: 1, "api-surface": 2, test: 3, suggestion: 4, question: 5, nit: 6 };

/** The comments to post: at most `MAX_INLINE_COMMENTS`, the gravest findings first, the pack's order otherwise. */
export function capComments<T extends { path: string; line: number }>(comments: T[], findings: Array<{ path: string; line: number; severity: string }>): T[] {
  if (comments.length <= MAX_INLINE_COMMENTS) return comments;
  const rank = (c: T) => {
    const found = findings.find((f) => f.path === c.path && f.line === c.line);
    return SEVERITY_RANK[found?.severity ?? ""] ?? 9;
  };
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, MAX_INLINE_COMMENTS)
    .map(({ c }) => c);
}

/** The PR a task came from, or null when the task is not a PR task. */
export function prOf(context: StageContext): { repo: string; number: number; url: string } | null {
  const source = context.task.source;
  return source?.kind === "github_pr" ? { repo: source.repo, number: source.number, url: source.url } : null;
}

/** The PR's facts as the review and address packs read them. Throws when GitHub no longer shows it. */
export async function gatherPr(gh: Gh, repo: string, number: number): Promise<ReviewContext["pr"]> {
  const node = await prFacts(gh, repo, number);
  if (!node) throw new Error(`${repo}#${number} is gone from GitHub`);
  return {
    repo,
    number,
    url: node.url,
    title: node.title,
    body: node.body ?? null,
    author: node.author?.login ?? "ghost",
    baseRef: node.baseRefName,
    headRef: node.headRefName,
  };
}

export function prReviewRunner(deps: PrReviewDeps): StageRunner {
  const gh = deps.gh ?? defaultGh;
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    let review: ReviewContext;
    try {
      const [facts, diff, files, existingComments] = await Promise.all([
        gatherPr(gh, pr.repo, pr.number),
        prDiff(gh, pr.repo, pr.number),
        prFiles(gh, pr.repo, pr.number),
        prComments(gh, pr.repo, pr.number),
      ]);
      review = { pr: facts, diff, files, existingComments };
    } catch (error) {
      return { outcome: "fail", detail: { error: error instanceof Error ? error.message : String(error) } };
    }

    const pack = await deps.runPack(context, review);
    if (pack.outcome !== "pass") return pack;
    const parsed = PrReviewAnswer.safeParse(pack.detail?.answer);
    if (!parsed.success) {
      return { ...pack, outcome: "fail", detail: { ...pack.detail, error: `the review answer does not parse: ${parsed.error.message}` } };
    }
    const answer = parsed.data;

    // The comment review goes out now; only a verdict waits for you.
    const comments = capComments(
      answer.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      answer.findings,
    );
    const posted = comments.length > 0;
    if (posted) {
      const error = await postReview(gh, pr.repo, pr.number, { event: "COMMENT", body: answer.summary, comments });
      if (error) return { ...pack, outcome: "fail", detail: { ...pack.detail, error } };
    }
    const base = { ...pack, findings: answer.findings };
    const detail = { ...pack.detail, summary: answer.summary, verdict: answer.verdict, posted, comments: comments.length };
    if (answer.verdict === "comment") return { ...base, detail };
    const requested: RequestedAction[] = [
      { kind: "pr_review_post", target: pr.url, payload: { event: EVENT_OF[answer.verdict], body: answer.summary } },
    ];
    return { ...base, detail: { ...detail, reason: "verdict" }, requested };
  };
}

/** The review route's `shipping`: posts the APPROVE / REQUEST_CHANGES review the gate carried. */
export function postVerdictRunner(deps: { gh?: Gh }): StageRunner {
  const gh = deps.gh ?? defaultGh;
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    const gate = context.approvals.filter((a) => a.kind === "awaiting_ship" && a.decision === "approved").at(-1);
    const actions = (gate?.requested as { actions?: RequestedAction[] } | undefined)?.actions ?? [];
    const post = actions.find((a) => a.kind === "pr_review_post");
    const event = post?.payload.event;
    if (!post || (event !== "APPROVE" && event !== "REQUEST_CHANGES")) {
      return { outcome: "fail", detail: { error: "the gate carried no verdict to post" } };
    }
    const body = typeof post.payload.body === "string" ? post.payload.body : "";
    const error = await postReview(gh, pr.repo, pr.number, { event, body, comments: [] });
    if (error) return { outcome: "fail", detail: { error } };
    return { outcome: "pass", detail: { posted: event, prUrl: pr.url } };
  };
}
