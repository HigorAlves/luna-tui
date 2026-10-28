import { describe, expect, it } from "vitest";

import type { Gh } from "../../adapters/github/gh.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { prAddressRunner, prFollowUpRunner } from "./pr-address.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

const node = {
  number: 12,
  title: "Export CSV",
  body: null,
  url: "https://github.com/o/a/pull/12",
  isDraft: false,
  updatedAt: "t",
  baseRefName: "main",
  headRefName: "feat/export",
  author: { login: "me" },
  headRepository: { nameWithOwner: "o/a" },
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "MERGEABLE",
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [] },
};
const threads = [
  { id: "T1", isResolved: false, path: "a.ts", line: 4, comments: { nodes: [{ author: { login: "them" }, body: "why?", createdAt: "t" }] } },
  { id: "T2", isResolved: false, path: "b.ts", line: 9, comments: { nodes: [{ author: { login: "them" }, body: "rename", createdAt: "t" }] } },
];

const context = (over: Record<string, unknown> = {}) =>
  ({
    task: {
      id: "t1",
      route: "address",
      branch: "feat/export",
      worktreePath: "/wt",
      repoPath: "/r/a",
      source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" },
      ...over,
    } as unknown as TaskRow,
    stage: "addressing",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  }) as StageContext;

describe("addressing", () => {
  it("hands the pack the PR and its unresolved threads and returns the pack's answer", async () => {
    const gh: Gh = async (args) => {
      if (args[0] === "api" && args[1] === "graphql") {
        const query = args[3] ?? "";
        if (query.includes("reviewThreads(first:100){nodes{ id")) return ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } }));
        return ok(JSON.stringify({ data: { repository: { pullRequest: node } } }));
      }
      return bad("unexpected");
    };
    let seen: unknown;
    const runPack = async (_c: StageContext, ctx: unknown): Promise<StageResult> => {
      seen = ctx;
      return { outcome: "pass", detail: { answer: { kind: "done", summary: "done", replies: [] } } };
    };
    const result = await prAddressRunner({ gh, runPack })(context());
    expect(result.outcome).toBe("pass");
    expect(seen).toMatchObject({
      pr: { repo: "o/a", number: 12, author: "me" },
      threads: [
        { id: "T1", path: "a.ts", line: 4, comments: [{ author: "them", body: "why?" }] },
        { id: "T2", path: "b.ts", line: 9 },
      ],
    });
  });

  it("fails when the PR has nothing left to address", async () => {
    const gh: Gh = async (args) =>
      args[3]?.includes("reviewThreads(first:100){nodes{ id")
        ? ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }))
        : ok(JSON.stringify({ data: { repository: { pullRequest: node } } }));
    const result = await prAddressRunner({ gh, runPack: async () => ({ outcome: "pass" }) })(context());
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toMatch(/no unresolved/);
  });
});

describe("the follow-up: push, reply, resolve", () => {
  function setup(opts: { resolvedAlready?: string[]; pushFails?: boolean; replyFails?: string[] } = {}) {
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return opts.pushFails ? bad("rejected") : ok();
    };
    const gh: Gh = async (args) => {
      calls.push(["gh", ...args]);
      const query = args[3] ?? "";
      const threadId = args.find((a) => a.startsWith("threadId="))?.slice(9) ?? "";
      if (query.includes("isResolved} }")) return ok(JSON.stringify({ data: { node: { isResolved: opts.resolvedAlready?.includes(threadId) ?? false } } }));
      if (query.includes("addPullRequestReviewThreadReply")) return opts.replyFails?.includes(threadId) ? bad("thread locked") : ok("{}");
      if (query.includes("resolveReviewThread")) return ok("{}");
      return bad("unexpected");
    };
    const answer = { kind: "done", summary: "s", replies: [{ threadId: "T1", body: "Fixed in abc.", resolve: true }, { threadId: "T2", body: "Kept as is.", resolve: false }] };
    const run = prFollowUpRunner({ gh, exec, latestAnswer: async () => answer });
    return { run, calls };
  }

  it("pushes the branch, replies to each thread and resolves the ones the agent marked", async () => {
    const { run, calls } = setup();
    const result = await run(context({ stage: "delivering" }));
    expect(result.outcome).toBe("pass");
    expect(calls[0]).toEqual(["git", "-c", "core.hooksPath=/dev/null", "-C", "/wt", "push", "-u", "origin", "feat/export"]);
    const replies = calls.filter((c) => c[0] === "gh" && c[4]?.includes("addPullRequestReviewThreadReply")).map((c) => c.find((a) => a.startsWith("threadId=")));
    expect(replies).toEqual(["threadId=T1", "threadId=T2"]);
    const resolved = calls.filter((c) => c[0] === "gh" && c[4]?.includes("resolveReviewThread")).map((c) => c.find((a) => a.startsWith("threadId=")));
    expect(resolved).toEqual(["threadId=T1"]);
    expect(result.detail).toMatchObject({ replied: 2, resolved: 1, skipped: [] });
  });

  it("skips a thread someone resolved meanwhile, and fails on a push or a refused reply", async () => {
    const skipped = setup({ resolvedAlready: ["T1"] });
    const result = await skipped.run(context({ stage: "delivering" }));
    expect(result.detail).toMatchObject({ replied: 1, resolved: 0, skipped: ["T1"] });

    const pushed = setup({ pushFails: true });
    expect((await pushed.run(context({ stage: "delivering" }))).outcome).toBe("fail");

    const refused = setup({ replyFails: ["T2"] });
    const failed = await refused.run(context({ stage: "delivering" }));
    expect(failed.outcome).toBe("fail");
    expect(String(failed.detail?.error)).toMatch(/T2/);
  });
});
