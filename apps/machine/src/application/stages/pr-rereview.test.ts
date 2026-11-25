import type { ReviewContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import type { Decide } from "./check-decide.ts";
import { prReviewRunner } from "./pr-review.ts";

const node = { number: 12, title: "Export CSV", body: "Adds the export.", url: "https://github.com/o/a/pull/12", isDraft: false, updatedAt: "t", baseRefName: "main", headRefName: "feat/export", author: { login: "them" }, headRepository: { nameWithOwner: "o/a" }, reviewDecision: null, mergeable: "MERGEABLE", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] } };
const context = { task: { id: "t1", route: "review", branch: "feat/export", worktreePath: "/wt", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" } } as unknown as TaskRow, stage: "reviewing", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;

const SINCE = "abc1234def5678";
const HEAD = "9f8e7d6c5b4a3210";
const FULL = "diff --git a/a.ts b/a.ts\n+whole pr\n";
const DELTA = "diff --git a/a.ts b/a.ts\n+only the delta\n";
const clean = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
const mine = { author: "luna", state: "COMMENTED", commitId: SINCE, at: "2026-11-24T10:00:00Z", association: "MEMBER" };
const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  path: "a.ts",
  line: 3,
  originalLine: 3,
  originalCommit: "old1234",
  comments: [{ author: "luna", body: `problem ${id}`, at: "2026-11-24T10:00:00Z" }, { author: "them", body: `reply ${id}`, at: "2026-11-24T11:00:00Z", association: "NONE" }],
  ...over,
});
const yes = { value: true, p: 0.97 };
const no = { value: false, p: 0.03 };

function setup(opts: { reviews?: unknown[]; threads?: unknown[]; mainAnswer?: unknown; decide?: Decide | null; delta?: string | null } = {}) {
  const github = fakeGitHub({
    viewer: async () => ({ login: "Luna", teams: [] }),
    prFacts: async () => node as never,
    prDiff: async () => FULL,
    prFiles: async () => [{ path: "a.ts", additions: 1, deletions: 0 }],
    prComments: async () => [],
    prReviews: async () => (opts.reviews ?? [mine]) as never,
    prThreads: async () => (opts.threads ?? []) as never,
  });
  const seen: { review?: ReviewContext; helperReview?: ReviewContext; asked: Array<{ pack: string; check: Record<string, unknown> }>; since: string[]; packs: number; helpers: number } = { asked: [], since: [], packs: 0, helpers: 0 };
  const run = prReviewRunner({
    github,
    runPack: async (_c, review) => ((seen.packs++, seen.review = review), { outcome: "pass", detail: { answer: opts.mainAnswer ?? clean } }),
    helpers: { run: async (_c, _p, review) => ((seen.helpers++, seen.helperReview = review), { outcome: "pass", detail: { answer: { summary: "ok", findings: [] } } }), decide: null },
    rereview: {
      git: {
        head: async () => HEAD,
        diffSince: async (_w, since) => (seen.since.push(since), opts.delta === undefined ? DELTA : opts.delta),
        fileAt: async (_w, rev, path) => `l1\nl2\nl3 at ${rev}:${path}\nl4`,
      },
      get decide() {
        const d: Decide = async () => ({ addressed: { value: false, p: 0.5 }, reply_holds: { value: false, p: 0.5 } });
        return opts.decide === undefined ? d : opts.decide;
      },
      readNow: async (_w, path, line) => `now ${path}:${line}`,
    },
  });
  return { run, seen, github };
}

type Payload = { event: string; body: string; comments: unknown[]; threadReplies: Array<{ threadId: string; body: string; resolve: boolean; by: string }> };
const payload = (result: Awaited<ReturnType<ReturnType<typeof setup>["run"]>>) => (result.requested?.[0] as unknown as { payload: Payload }).payload;

describe("a re-review", () => {
  it("runs the normal review when no review of ours exists: the whole diff, no thread read", async () => {
    const { run, seen } = setup({ reviews: [{ ...mine, author: "someone" }], threads: [thread("T1")] });
    const result = await run(context);
    expect(seen.review!.diff).toBe(FULL);
    expect(seen.review!.rereview).toBeUndefined();
    expect(seen.since).toEqual([]);
    expect(payload(result).threadReplies).toBeUndefined();
  });

  it("reviews only the delta since our latest review (found by the viewer's login, whoever posted it), and hands the helpers the delta without the threads", async () => {
    const older = { ...mine, commitId: "0000000aaaa", at: "2026-11-20T10:00:00Z" };
    const { run, seen } = setup({ reviews: [older, mine, { ...mine, author: "other", commitId: "ffff" }], threads: [thread("T1")] });
    await run(context);
    expect(seen.since).toEqual([SINCE]);
    expect(seen.review!.diff).toBe(DELTA);
    expect(seen.review!.rereview).toMatchObject({ since: SINCE });
    expect(seen.review!.rereview!.note).toBeUndefined();
    expect(seen.helperReview!.diff).toBe(DELTA);
    expect(seen.helperReview!.rereview).toBeUndefined();
  });

  it("falls back to the whole diff with a note when our commit is no longer in the branch", async () => {
    const { run, seen } = setup({ delta: null, threads: [thread("T1")] });
    await run(context);
    expect(seen.review!.diff).toBe(FULL);
    expect(seen.review!.rereview!.note).toMatch(/force-push|no longer/i);
  });

  it("settles a fixed thread with a templated reply and a resolve, and keeps it from the reviewer", async () => {
    const { run, seen } = setup({ threads: [thread("T1")], decide: async () => ({ addressed: yes, reply_holds: no }) });
    const result = await run(context);
    expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", body: "Fixed in `9f8e7d6`.", resolve: true, by: "decision" })]);
    expect(seen.review!.rereview!.threads).toEqual([expect.objectContaining({ id: "T1", settle: "fixed" })]);
    expect(payload(result).event).toBe("APPROVE");
    expect(payload(result).comments).toEqual([]);
    expect(result.detail).toMatchObject({ verdict: "approve", rereview: { since: SINCE, settled: 1, open: 0 } });
  });

  it("settles a thread whose author reply holds, when it is not fixed", async () => {
    const { run } = setup({ threads: [thread("T1")], decide: async () => ({ addressed: no, reply_holds: yes }) });
    const result = await run(context);
    expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", body: "Fair point, resolving.", resolve: true })]);
  });

  it("does not settle on a reply nobody wrote: no author reply, no reply_holds", async () => {
    const lonely = thread("T1", { comments: [{ author: "luna", body: "problem", at: "t" }] });
    const { run, seen } = setup({ threads: [lonely], decide: async () => ({ addressed: no, reply_holds: yes }), mainAnswer: { ...clean, threads: [{ threadId: "T1", decision: "open", severity: "bug", body: "Still open because nothing changed." }] } });
    const result = await run(context);
    expect(seen.review!.rereview!.threads[0]!.settle).toBe("unsettled");
    expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", resolve: false, by: "reviewer" })]);
  });

  it("sends a thread the decision is unsure of, or could not read, to the reviewer, and lets an open one block the verdict at its severity", async () => {
    const unsure = async () => ({ addressed: { value: true, p: 0.6 }, reply_holds: no });
    for (const decide of [unsure, null, async () => { throw new Error("jev down"); }]) {
      const { run, seen } = setup({ threads: [thread("T1")], decide: decide as Decide | null, mainAnswer: { ...clean, threads: [{ threadId: "T1", decision: "open", severity: "bug", body: "Still open because the loop still skips a row." }] } });
      const result = await run(context);
      expect(seen.review!.rereview!.threads[0]!.settle).toBe("unsettled");
      expect(payload(result).event).toBe("REQUEST_CHANGES");
      expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", body: "Still open because the loop still skips a row.", resolve: false, by: "reviewer" })]);
      expect(result.detail).toMatchObject({ verdict: "request_changes", rereview: { settled: 0, open: 1 } });
    }
  });

  it("approves when the reviewer resolves what the decision left and nothing is new", async () => {
    const { run } = setup({ threads: [thread("T1")], mainAnswer: { ...clean, threads: [{ threadId: "T1", decision: "resolve", severity: "nit", body: "Agreed, thanks." }] } });
    const result = await run(context);
    expect(payload(result).event).toBe("APPROVE");
    expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", body: "Agreed, thanks.", resolve: true, by: "reviewer" })]);
  });

  it("leaves a thread the reviewer did not answer open, with no reply, and it keeps the review from approving", async () => {
    const { run } = setup({ threads: [thread("T1")] });
    const result = await run(context);
    expect(payload(result).threadReplies).toEqual([]);
    expect(payload(result).event).toBe("COMMENT");
    expect(result.detail).toMatchObject({ rereview: { open: 1 } });
  });

  it("still requests changes for a new finding on the delta even when every thread is settled", async () => {
    const finding = { path: "a.ts", line: 1, severity: "bug", title: "New bug", body: "b", confidence: 0.9 };
    const { run } = setup({ threads: [thread("T1")], decide: async () => ({ addressed: yes, reply_holds: no }), mainAnswer: { verdict: "request_changes", summary: "One.", findings: [finding], comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "New bug" }] } });
    const result = await run(context);
    expect(payload(result).event).toBe("REQUEST_CHANGES");
    expect(payload(result).comments).toHaveLength(1);
    expect(payload(result).threadReplies).toHaveLength(1);
  });

  it("settles only our threads: a thread someone else started is left alone", async () => {
    const theirs = thread("T9", { comments: [{ author: "them", body: "my own thread", at: "t" }] });
    const { run, seen } = setup({ threads: [theirs, thread("T1")], decide: async () => ({ addressed: yes, reply_holds: no }) });
    const result = await run(context);
    expect(seen.review!.rereview!.threads.map((t) => t.id)).toEqual(["T1"]);
    expect(payload(result).threadReplies.map((r) => r.threadId)).toEqual(["T1"]);
  });

  it("asks thread_settle with the thread as data, the code at the original line, the code now and the delta for that path", async () => {
    const asked: Array<{ pack: string; check: Record<string, unknown> }> = [];
    const { run } = setup({ threads: [thread("T1")], decide: (async (pack, check) => (asked.push({ pack, check: check as never }), { addressed: no, reply_holds: no })) as Decide });
    await run(context);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.pack).toBe("thread_settle");
    const t = (asked[0]!.check as { kind: string; thread: { comments: Array<{ ours: boolean; body: string }>; original: string; current: string; delta: string; path: string } }).thread;
    expect((asked[0]!.check as { kind: string }).kind).toBe("thread");
    expect(t.comments[0]).toMatchObject({ ours: true, body: "problem T1" });
    expect(t.comments[1]!.ours).toBe(false);
    expect(t.comments[1]!.body).toMatch(/^\[untrusted/);
    expect(t.comments[1]!.body).toContain("reply T1");
    expect(t.original).toContain("l3 at old1234:a.ts");
    expect(t.current).toBe("now a.ts:3");
    expect(t.delta).toContain("+only the delta");
  });
});

describe("a re-review when the PR has no new commits since our latest review", () => {
  // Our latest review read HEAD itself: the delta is empty, so only our threads can have moved.
  const atHead = { ...mine, commitId: HEAD, at: "2026-11-24T10:00:00Z" };
  const ourReply = { author: "luna", body: "Still open because it still loops.", at: "2026-11-24T10:00:05Z" };
  const theirAgain = { author: "them", body: "Confirmed unchanged.", at: "2026-11-24T10:01:00Z", association: "NONE" };
  const finding = { id: "f1", path: "b.ts", line: 9, severity: "bug", title: "new thing", body: "b", confidence: 0.9 };

  it("runs no review pass and posts no new finding: there is no new code to read", async () => {
    const { run, seen } = setup({ reviews: [atHead], delta: "", threads: [thread("T1")], mainAnswer: { ...clean, findings: [finding], comments: [{ path: "b.ts", line: 9, side: "RIGHT", body: "new" }], threads: [{ threadId: "T1", decision: "open", severity: "question", body: "Still open because the reply does not change it." }] } });
    const result = await run(context);
    expect(seen.helpers).toBe(0);
    expect(seen.packs).toBe(1);
    expect(payload(result).comments).toEqual([]);
    expect(result.findings ?? []).toEqual([]);
    expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", resolve: false })]);
  });

  it("never answers a thread twice at the same head: one we already replied to since our review is left quiet, so the review and the author's agent cannot ping-pong", async () => {
    const { run, seen } = setup({ reviews: [atHead], delta: "", threads: [thread("T1", { comments: [{ author: "luna", body: "problem", at: "2026-11-24T10:00:00Z" }, { author: "them", body: "reply", at: "2026-11-24T09:59:00Z" }, ourReply, theirAgain] })] });
    const result = await run(context);
    expect(seen.packs).toBe(0);
    expect(seen.helpers).toBe(0);
    expect(result.outcome).toBe("pass");
    expect(result.requested ?? []).toEqual([]);
    expect(result.detail).toMatchObject({ reason: "watching", rereview: { settled: 0, threads: 1 } });
  });

  it("still resolves such a thread when the author's latest reply holds, without asking the reviewer", async () => {
    const { run, seen } = setup({ reviews: [atHead], delta: "", decide: async () => ({ addressed: no, reply_holds: yes }), threads: [thread("T1", { comments: [{ author: "luna", body: "problem", at: "2026-11-24T10:00:00Z" }, ourReply, theirAgain] })] });
    const result = await run(context);
    expect(seen.packs).toBe(0);
    expect(payload(result).threadReplies).toEqual([expect.objectContaining({ threadId: "T1", body: "Fair point, resolving.", resolve: true, by: "decision" })]);
  });

  it("answers a thread again once new commits came in, even if we replied before them", async () => {
    const { run, seen } = setup({ reviews: [atHead], delta: DELTA, threads: [thread("T1", { comments: [{ author: "luna", body: "problem", at: "2026-11-24T09:00:00Z" }, { ...ourReply, at: "2026-11-24T09:30:00Z" }, theirAgain] })] });
    await run(context);
    expect(seen.packs).toBe(1);
    expect(seen.review!.rereview!.threads[0]).toMatchObject({ id: "T1", settle: "unsettled" });
  });
});
