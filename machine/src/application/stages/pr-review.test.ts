import { describe, expect, it } from "vitest";

import type { Gh } from "../../adapters/github/gh.ts";
import type { ApprovalRow, TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { postVerdictRunner, prReviewRunner } from "./pr-review.ts";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string) => ({ code: 1, stdout: "", stderr });

const node = {
  number: 12,
  title: "Export CSV",
  body: "Adds the export.",
  url: "https://github.com/o/a/pull/12",
  isDraft: false,
  updatedAt: "t",
  baseRefName: "main",
  headRefName: "feat/export",
  author: { login: "them" },
  headRepository: { nameWithOwner: "o/a" },
  reviewDecision: null,
  mergeable: "MERGEABLE",
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [] },
};

function setup(answer: Record<string, unknown> | null, opts: { postFails?: boolean } = {}) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") return ok(JSON.stringify({ data: { repository: { pullRequest: node } } }));
    if (args[0] === "pr" && args[1] === "diff") return ok("diff --git a/a.ts b/a.ts\n+export const x = 1;\n");
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ files: [{ path: "a.ts", additions: 1, deletions: 0 }] }));
    if (args[0] === "api" && args[1]?.endsWith("/comments")) return ok(JSON.stringify([{ path: "a.ts", line: 1, user: { login: "x" }, body: "old" }]));
    if (args[0] === "api" && args[1] === "--method") return opts.postFails ? bad("422 Unprocessable") : ok("{}");
    return bad(`unexpected ${args.join(" ")}`);
  };
  let seen: unknown;
  const runPack = async (_context: StageContext, review: unknown): Promise<StageResult> => {
    seen = review;
    return answer ? { outcome: "pass", detail: { answer, summary: String(answer.summary) } } : { outcome: "escalated", detail: { reason: "unclear" } };
  };
  const context = {
    task: {
      id: "t1",
      route: "review",
      branch: "feat/export",
      worktreePath: "/wt",
      repoPath: "/r/a",
      source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" },
    } as unknown as TaskRow,
    stage: "reviewing",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: prReviewRunner({ gh, runPack }), context, calls, review: () => seen };
}

const posted = (calls: string[][]) => calls.filter((c) => c[0] === "api" && c[1] === "--method");

describe("reviewing", () => {
  it("hands the pack the diff, files and existing comments, then posts one COMMENT review and closes", async () => {
    const { run, context, calls, review } = setup({
      verdict: "comment",
      summary: "Two nits.",
      findings: [],
      comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }],
    });
    const result = await run(context);
    expect(review()).toMatchObject({
      pr: { repo: "o/a", number: 12, title: "Export CSV", body: "Adds the export.", author: "them", baseRef: "main", headRef: "feat/export" },
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
      existingComments: [{ path: "a.ts", line: 1, author: "x", body: "old" }],
    });
    expect(String((review() as { diff: string }).diff)).toContain("+export const x = 1;");
    expect(posted(calls)).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "pass", detail: { verdict: "comment", posted: true } });
    expect(result.detail?.reason).toBeUndefined();
  });

  it("posts the comments right away and waits for you when the verdict is approve or request changes", async () => {
    const { run, context, calls } = setup({ verdict: "request_changes", summary: "Blocking.", findings: [], comments: [{ path: "a.ts", line: 1, body: "bug" }] });
    const result = await run(context);
    expect(posted(calls)).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "pass", detail: { reason: "verdict", verdict: "request_changes" } });
    expect(result.requested).toEqual([
      { kind: "pr_review_post", target: node.url, payload: { event: "REQUEST_CHANGES", body: "Blocking." } },
    ]);
  });

  it("posts nothing when there are no comments and no verdict, and passes an escalation through", async () => {
    const quiet = setup({ verdict: "comment", summary: "Looks fine.", findings: [], comments: [] });
    const result = await quiet.run(quiet.context);
    expect(posted(quiet.calls)).toHaveLength(0);
    expect(result.detail).toMatchObject({ posted: false });
    const escalated = setup(null);
    expect((await escalated.run(escalated.context)).outcome).toBe("escalated");
  });

  it("fails with gh's words when the post is refused", async () => {
    const { run, context } = setup({ verdict: "comment", summary: "s", findings: [], comments: [{ path: "a.ts", line: 1, body: "nit" }] }, { postFails: true });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toMatch(/422/);
  });
});

describe("posting the verdict", () => {
  const approval = (actions: unknown[], decision: ApprovalRow["decision"] = "approved"): ApprovalRow =>
    ({ id: "a1", taskId: "t1", kind: "awaiting_ship", requested: { actions }, decision, reason: null, response: null, createdAt: new Date(), decidedAt: new Date() }) as ApprovalRow;

  it("posts the review the gate carried, as its event", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return ok("{}");
    };
    const run = postVerdictRunner({ gh });
    const { context } = setup(null);
    const result = await run({ ...context, stage: "shipping", approvals: [approval([{ kind: "pr_review_post", target: node.url, payload: { event: "APPROVE", body: "LGTM" } }])] });
    expect(result.outcome).toBe("pass");
    expect(calls[0]!.slice(0, 4)).toEqual(["api", "--method", "POST", "repos/o/a/pulls/12/reviews"]);
  });

  it("fails when the gate carried no review to post", async () => {
    const run = postVerdictRunner({ gh: async () => ok("{}") });
    const { context } = setup(null);
    const result = await run({ ...context, stage: "shipping", approvals: [approval([])] });
    expect(result.outcome).toBe("fail");
  });
});
