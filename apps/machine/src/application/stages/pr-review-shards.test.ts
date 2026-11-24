import type { ReviewContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { prReviewRunner } from "./pr-review.ts";

const node = { number: 12, title: "Export CSV", body: "Adds the export.", url: "https://github.com/o/a/pull/12", isDraft: false, updatedAt: "t", baseRefName: "main", headRefName: "feat/export", author: { login: "them" }, headRepository: { nameWithOwner: "o/a" }, reviewDecision: null, mergeable: "MERGEABLE", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] } };
const context = { task: { id: "t1", route: "review", branch: "feat/export", worktreePath: "/wt", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" } } as unknown as TaskRow, stage: "reviewing", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;

/** A file's section: 4 header lines and n added lines. */
const sec = (path: string, n: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${n} @@\n` + Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n") + "\n";
/** Six modules of two 30-line files each: with a 60-line shard, a module per shard. */
const modules = ["m1", "m2", "m3", "m4", "m5", "m6"];
const bigDiff = modules.flatMap((m) => [sec(`${m}/a.ts`, 26), sec(`${m}/b.ts`, 26)]).join("");
const clean = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
const bug = (path: string) => ({ path, line: 1, severity: "bug", title: `bug in ${path}`, body: "wrong", confidence: 0.9 });
const pathsOf = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]!);

interface Opts {
  diff?: string;
  shardLines?: number;
  maxShards?: number;
  withWorkspace?: boolean;
  withFiles?: boolean;
  answer?: (review: ReviewContext) => unknown;
  failShard?: number;
  rereview?: { delta: string; threads: unknown[] };
}

function setup(opts: Opts = {}) {
  const github = fakeGitHub({
    viewer: async () => ({ login: "Luna", teams: [] }),
    prFacts: async () => node as never,
    prDiff: async () => opts.diff ?? bigDiff,
    prFiles: async () => [],
    prComments: async () => [],
    prReviews: async () => (opts.rereview ? [{ author: "luna", state: "COMMENTED", commitId: "abc1234def5678", at: "2026-11-24T10:00:00Z", association: "MEMBER" }] : []) as never,
    prThreads: async () => (opts.rereview?.threads ?? []) as never,
  });
  const log = {
    shardRuns: [] as Array<{ review: ReviewContext; workspace?: { path: string; branch: string } }>,
    passRuns: [] as Array<{ pack: string; review: ReviewContext; workspace?: { path: string }; mounts?: unknown }>,
    made: [] as string[],
    removed: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    written: [] as Array<{ runId: string; paths: string[]; whole: string }>,
    unwritten: [] as string[],
    compliance: [] as Array<ReviewContext | null>,
  };
  const run = prReviewRunner({
    github,
    limits: async () => ({ shardLines: opts.shardLines ?? 60, maxShards: opts.maxShards ?? 25 }),
    runPack: async (_c, review, workspace) => {
      log.shardRuns.push({ review, ...(workspace ? { workspace } : {}) });
      log.inFlight++;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      log.inFlight--;
      if (opts.failShard !== undefined && review.shard?.n === opts.failShard) throw new Error("the shard's run broke");
      const answer = opts.answer ? opts.answer(review) : { ...clean, summary: `Shard ${review.shard?.n ?? 1} read ${pathsOf(review.diff).join(", ")}.` };
      return { outcome: "pass", usage: { turns: 2, costUsd: 1, tokens: null }, detail: { answer } } satisfies StageResult;
    },
    helpers: {
      ...(opts.withWorkspace === false
        ? {}
        : {
            workspace: {
              make: async (sub: StageContext, label: string) => {
                const path = `/clones/${sub.runId}`;
                log.made.push(path);
                return { path, branch: `luna-review/${label}` };
              },
              remove: (w: { path: string }) => void log.removed.push(w.path),
            },
          }),
      run: async (_c: StageContext, pack: string, review: ReviewContext, workspace?: { path: string }, mounts?: unknown) => {
        log.passRuns.push({ pack, review, ...(workspace ? { workspace } : {}), mounts });
        return { outcome: "pass", detail: { answer: { summary: `${pack} looked`, findings: [] } } } satisfies StageResult;
      },
      decide: null,
    },
    ...(opts.withFiles === false
      ? {}
      : {
          diffFiles: {
            write: async (runId: string, files: readonly { path: string }[], whole: string) => (log.written.push({ runId, paths: files.map((f) => f.path), whole }), { host: `/state/${runId}-prdiff` }),
            remove: async (host: string) => void log.unwritten.push(host),
          },
        }),
    compliance: {
      regimes: async () => [{ id: "gdpr" } as never],
      wiki: { readPages: async () => [] } as never,
      run: async (_c: StageContext, review: ReviewContext | null) => (log.compliance.push(review), { outcome: "pass", detail: { answer: { summary: "", findings: [], comments: [] } } } satisfies StageResult),
    },
    ...(opts.rereview
      ? {
          rereview: {
            git: { head: async () => "9f8e7d6c5b4a3210", diffSince: async () => opts.rereview!.delta, fileAt: async () => "l1" },
            decide: null,
            readNow: async () => "",
          },
        }
      : {}),
  });
  return { run, log };
}

type Posted = { event: string; body: string; comments: Array<{ path: string; body: string }> };
const payload = (r: Awaited<ReturnType<ReturnType<typeof setup>["run"]>>) => (r.requested?.[0] as unknown as { payload: Posted }).payload;

describe("a diff that fits one shard", () => {
  it("is reviewed by one reviewer in the card's workspace, exactly as before", async () => {
    const { run, log } = setup({ shardLines: 4000 });
    const result = await run(context);
    expect(log.shardRuns).toHaveLength(1);
    expect(log.shardRuns[0]!.workspace).toBeUndefined();
    expect(log.shardRuns[0]!.review.shard).toBeUndefined();
    expect(log.shardRuns[0]!.review.diffDir).toBeUndefined();
    expect(log.made).toEqual([...log.made].filter((p) => p.endsWith("-review_security") || p.includes("review_")));
    for (const pass of log.passRuns) {
      expect(pass.review.diffDir).toBeUndefined();
      expect(pass.review.diff).toContain("m1/a.ts");
    }
    expect(log.written).toEqual([]);
    expect(result.detail).not.toHaveProperty("shards");
  });
});

describe("a diff too big for one reviewer", () => {
  it("runs the main reviewer once per shard, each in a clone of its own, holding only its shard's diff and every file of the PR", async () => {
    const { run, log } = setup();
    const result = await run(context);
    expect(log.shardRuns).toHaveLength(6);
    const bySize = log.shardRuns.map((s) => s.review).sort((a, b) => a.shard!.n - b.shard!.n);
    expect(bySize.map((r) => r.shard)).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ n, of: 6 })));
    bySize.forEach((r, i) => {
      expect(pathsOf(r.diff)).toEqual([`${modules[i]}/a.ts`, `${modules[i]}/b.ts`]);
      expect(r.files).toHaveLength(12);
      expect(r.diffDir).toBeUndefined();
    });
    const paths = log.shardRuns.map((s) => s.workspace?.path);
    expect(paths.every(Boolean)).toBe(true);
    expect(new Set(paths).size).toBe(6);
    expect(paths.every((p) => p !== "/wt")).toBe(true);
    expect(result.detail).toMatchObject({ shards: { count: 6, reviewed: 6 } });
  });

  it("runs at most four shards at once, and all four when it can", async () => {
    const { run, log } = setup();
    await run(context);
    expect(log.maxInFlight).toBe(4);
  });

  it("removes every shard's clone, also when a shard's run breaks, and goes on with the others", async () => {
    const { run, log } = setup({ failShard: 3 });
    const result = await run(context);
    const shardClones = log.made.filter((p) => p.includes("-shard-"));
    expect(shardClones).toHaveLength(6);
    expect([...log.removed].sort()).toEqual([...log.made].sort());
    // A shard that broke leaves its files unreviewed, said at the gate, and the review does not claim to approve past them.
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ shards: { count: 6, reviewed: 5 } });
    const unreviewed = (result.detail as { unreviewed: Array<{ path: string }> }).unreviewed.map((u) => u.path);
    expect(unreviewed).toEqual(["m3/a.ts", "m3/b.ts"]);
    expect(result.detail).toMatchObject({ verdict: "comment" });
    expect(payload(result).body).toContain("Not reviewed: m3/a.ts, m3/b.ts");
  });

  it("fails the review when no shard could run", async () => {
    const { run } = setup({ answer: () => "not an answer" });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
  });

  it("merges the shards' findings and comments into one review with one summary built from theirs", async () => {
    const { run } = setup({
      answer: (review) => {
        const first = pathsOf(review.diff)[0]!;
        return { verdict: "comment", summary: `Read ${first}.`, findings: [bug(first), bug("m1/a.ts")], comments: [{ path: first, line: 1, side: "RIGHT", body: "bug" }] };
      },
    });
    const result = await run(context);
    // m1/a.ts's finding was made by every shard: one finding.
    const findings = result.findings!.map((f) => f.path).sort();
    expect(findings).toEqual(["m1/a.ts", "m2/a.ts", "m3/a.ts", "m4/a.ts", "m5/a.ts", "m6/a.ts"]);
    const body = payload(result).body;
    for (const m of modules) expect(body).toContain(`Read ${m}/a.ts.`);
    expect(payload(result).event).toBe("REQUEST_CHANGES");
    expect(result.usage).toMatchObject({ turns: 12 + 4 * 0 });
  });

  it("hands the four passes the whole PR once, as files in a read-only mount, with no diff inline and no shard workspace", async () => {
    const { run, log } = setup();
    await run(context);
    expect(log.passRuns).toHaveLength(4);
    expect(log.written).toHaveLength(1);
    expect(log.written[0]!.paths).toHaveLength(12);
    expect(log.written[0]!.whole).toContain("m6/b.ts");
    for (const pass of log.passRuns) {
      expect(pass.review.diff).toBe("");
      expect(pass.review.diffDir).toBe("/pr-diff");
      expect(pass.review.shard).toBeUndefined();
      expect(pass.review.files).toHaveLength(12);
      expect(pass.mounts).toEqual([{ host: "/state/r1-prdiff", container: "/pr-diff", readOnly: true }]);
    }
    // The compliance lead reads it the same way, and the folder goes only after it is done.
    expect(log.compliance).toHaveLength(1);
    expect(log.compliance[0]).toMatchObject({ diff: "", diffDir: "/pr-diff" });
    expect(log.unwritten).toEqual(["/state/r1-prdiff"]);
  });

  it("skips the passes with a note when it cannot write the diff files, and still reviews", async () => {
    const { run, log } = setup({ withFiles: false });
    const result = await run(context);
    expect(log.passRuns).toHaveLength(0);
    expect(log.shardRuns).toHaveLength(6);
    expect((result.detail as { helperNotes?: string[] }).helperNotes?.join(" ")).toMatch(/too big/);
  });

  it("runs shards one after another in the card's folder when there is no way to make them clones", async () => {
    const { run, log } = setup({ withWorkspace: false });
    await run(context);
    expect(log.shardRuns).toHaveLength(6);
    expect(log.maxInFlight).toBe(1);
    expect(log.shardRuns.every((s) => s.workspace === undefined)).toBe(true);
  });
});

describe("a diff over the cap", () => {
  const withAuth = () => {
    const files = [sec("docs/a.md", 26), sec("docs/b.md", 26), sec("src/auth/login.ts", 26), sec("src/auth/token.ts", 26), sec("src/x/util.ts", 26), sec("src/x/more.ts", 26), sec("test/a.test.ts", 26), sec("test/b.test.ts", 26)];
    return files.join("");
  };

  it("reviews the shards that matter most, lists the rest as unreviewed and says so in the summary and the detail", async () => {
    const { run, log } = setup({ diff: withAuth(), maxShards: 2 });
    const result = await run(context);
    const read = log.shardRuns.flatMap((s) => pathsOf(s.review.diff)).sort();
    expect(read).toEqual(["src/auth/login.ts", "src/auth/token.ts", "src/x/more.ts", "src/x/util.ts"]);
    expect(log.shardRuns.map((s) => s.review.shard)).toEqual(expect.arrayContaining([{ n: 1, of: 2 }, { n: 2, of: 2 }]));
    const detail = result.detail as { unreviewed: Array<{ path: string; lines: number }>; shards: { count: number; reviewed: number } };
    expect(detail.shards).toEqual({ count: 4, reviewed: 2 });
    expect(detail.unreviewed).toEqual([
      { path: "test/a.test.ts", lines: 30 },
      { path: "test/b.test.ts", lines: 30 },
      { path: "docs/a.md", lines: 30 },
      { path: "docs/b.md", lines: 30 },
    ]);
    expect(payload(result).body).toContain("Not reviewed: test/a.test.ts, test/b.test.ts, docs/a.md, docs/b.md");
    // Nothing unread can be approved past.
    expect(result.detail).toMatchObject({ verdict: "comment" });
    expect(payload(result).event).toBe("COMMENT");
  });

  it("the passes still read the whole PR", async () => {
    const { run, log } = setup({ diff: withAuth(), maxShards: 2 });
    await run(context);
    expect(log.written[0]!.paths).toHaveLength(8);
  });
});

describe("a re-review of a diff too big for one reviewer", () => {
  const thread = (id: string, path: string | null) => ({
    id,
    path,
    line: 1,
    originalLine: 1,
    originalCommit: "old1234",
    comments: [{ author: "luna", body: `problem ${id}`, at: "2026-11-24T10:00:00Z" }],
  });

  it("gives each thread to the shard that holds its file, and the ones in no shard to the first", async () => {
    const { run, log } = setup({ rereview: { delta: bigDiff, threads: [thread("T3", "m3/a.ts"), thread("T9", "gone/x.ts"), thread("TN", null), thread("T6", "m6/b.ts")] } });
    await run(context);
    const threadsOf = (n: number) => (log.shardRuns.find((s) => s.review.shard?.n === n)!.review.rereview!.threads.map((t) => t.id)).sort();
    expect(threadsOf(1)).toEqual(["T9", "TN"]);
    expect(threadsOf(3)).toEqual(["T3"]);
    expect(threadsOf(6)).toEqual(["T6"]);
    expect(threadsOf(2)).toEqual([]);
    for (const s of log.shardRuns) expect(s.review.rereview!.since).toBe("abc1234def5678");
  });

  it("answers every thread whichever shard answered it, and leaves one open when its shard did not", async () => {
    const answers = (review: ReviewContext) => ({
      ...clean,
      threads: review.rereview!.threads.filter((t) => t.id !== "T6").map((t) => ({ threadId: t.id, decision: "resolve", severity: "nit", body: "Thanks." })),
    });
    const { run } = setup({ answer: answers, rereview: { delta: bigDiff, threads: [thread("T3", "m3/a.ts"), thread("T6", "m6/b.ts")] } });
    const result = await run(context);
    const replies = (payload(result) as unknown as { threadReplies: Array<{ threadId: string; resolve: boolean }> }).threadReplies;
    expect(replies).toEqual([{ threadId: "T3", body: "Thanks.", resolve: true, by: "reviewer", path: "m3/a.ts", line: 1 }]);
    expect(result.detail).toMatchObject({ rereview: { open: 1, threads: 2 } });
    expect(result.detail).toMatchObject({ verdict: "comment" });
  });
});
