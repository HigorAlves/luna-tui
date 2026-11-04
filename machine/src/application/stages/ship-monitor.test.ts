import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvidencePack } from "@hardness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY, type Policy } from "../../domain/policy.ts";
import type { PrNode } from "../../domain/pull-request.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { GitHub } from "../github.ts";
import type { GitExec } from "../../adapters/git/worktree.ts";
import type { StageContext } from "../ports.ts";
import { emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";
import type { ReviewLoop } from "./ship-fixes.ts";
import { type ShipMonitorDeps, shipMonitor } from "./ship-monitor.ts";

const HEAD = "9c1f0e2a7b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
const START = new Date("2026-11-04T12:00:00Z");
const REF = { slug: "o/a", number: 3, url: "https://github.com/o/a/pull/3" };

const node = (over: Partial<PrNode> = {}): PrNode => ({
  id: "PR_1",
  number: 3,
  title: "t",
  body: null,
  url: REF.url,
  isDraft: false,
  updatedAt: "2026-11-04T11:00:00Z",
  baseRefName: "main",
  headRefName: "hardness/t1",
  author: { login: "me" },
  headRepository: { nameWithOwner: "o/a" },
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { oid: HEAD, committedDate: "2026-11-03T10:00:00Z", statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }] } } } }] },
  ...over,
});

const pack = (risk: EvidencePack["risk"] = "low", commitSha = HEAD): EvidencePack => ({ summary: "s", format: "text", scenarios: [], findings: [], outOfMap: [], risk, rollback: "r", howToVerify: "h", commitSha, media: [], at: "2026-11-04T00:00:00.000Z" });

const open = { merged: false, mergedSha: null, state: "open" as const, mergedAt: null };
const merged = { merged: true, mergedSha: "m1", state: "closed" as const, mergedAt: "2026-11-04T12:30:00Z" };

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "ship-monitor-"));
});
afterEach(() => rm(stateDir, { recursive: true, force: true }));

function setup(
  answers: Partial<GitHub> = {},
  over: { policy?: Partial<Policy>; pack?: EvidencePack | null; approvals?: StageContext["approvals"]; maxWaitMs?: number; codeowners?: string | null; abort?: AbortController; loop?: ShipMonitorDeps["loop"]; evidence?: Partial<ShipMonitorDeps["evidence"]>; viewer?: boolean } = {},
) {
  const github = fakeGitHub({ viewer: async () => ({ login: "me", teams: [] }), prMerged: async () => open, prFacts: async () => node(), prHeadSha: async () => HEAD, prActivity: async () => [], prFiles: async () => [], mergePr: async () => {}, ...answers });
  let clock = START.getTime();
  const slept: number[] = [];
  const notes: string[] = [];
  const deps: ShipMonitorDeps = {
    github,
    policies: { for: async () => ({ ...DEFAULT_POLICY, ...over.policy }) },
    evidence: { load: async () => (over.pack === undefined ? pack() : over.pack), ...over.evidence },
    stateDir,
    pollMs: 60_000,
    ...(over.maxWaitMs !== undefined ? { maxWaitMs: over.maxWaitMs } : {}),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => new Date(clock),
    readCodeowners: async () => over.codeowners ?? null,
    // The review loop's decisions and sub-runs (slice 5); absent, the monitor only notes activity.
    ...(over.loop ? { loop: over.loop } : {}),
  };
  const context = {
    task: { id: "t1", repoPath: "/repo", worktreePath: "/wt", branch: "hardness/t1" },
    approvals: over.approvals ?? [],
    signal: (over.abort ?? new AbortController()).signal,
    note: async (text: string) => void notes.push(text),
  } as unknown as StageContext;
  return { run: () => shipMonitor(deps)(context, REF), github, slept, notes, advance: (ms: number) => void (clock += ms) };
}

/** A fake whose only answers are the ones the default CODEOWNERS reader and a one-poll merge need. */
function fakeGitHubFrom(fileAtRef: (slug: string, ref: string, path: string) => Promise<string | null>) {
  return fakeGitHub({ fileAtRef, prMerged: async () => open, prFacts: async () => node(), prHeadSha: async () => HEAD, prActivity: async () => [], prFiles: async () => [], mergePr: async () => {} });
}

const calls = (github: ReturnType<typeof fakeGitHub>, method: string) => github.calls.filter((c) => c[0] === method);

describe("the ship monitor", () => {
  it("merges a green approved low-risk PR at the first poll when auto_merge allows it, with the head sha as the guard", async () => {
    const { run, github, slept } = setup({}, { policy: { autoMerge: "low" } });
    const result = await run();
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { sha: HEAD, by: "machine" }, prUrl: REF.url, number: 3 } });
    expect(calls(github, "mergePr")).toEqual([["mergePr", "o/a", 3, { sha: HEAD }]]);
    expect(slept).toEqual([]);
  });

  it("does not merge with auto_merge off, and passes when a person merges later", async () => {
    let polls = 0;
    const { run, github, slept, notes } = setup({ prMerged: async () => (++polls < 3 ? open : merged) });
    const result = await run();
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { sha: "m1", by: "person" } } });
    expect(calls(github, "mergePr")).toEqual([]);
    expect(slept).toEqual([60_000, 60_000]);
    expect(notes.filter((n) => /auto-merge/.test(n))).toHaveLength(1);
  });

  it("calls a merge that followed its own request the machine's, even when seen on a later poll (a merge queue)", async () => {
    let polls = 0;
    const { run } = setup({ prMerged: async () => (++polls < 2 ? open : merged), mergePr: async () => ({ queued: true }) }, { policy: { autoMerge: "low" } });
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" } } });
  });

  it("holds a high-risk PR with no ship approver, naming nothing it may not say, and merges once there is one", async () => {
    const none = setup({ prMerged: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(merged) }, { policy: { autoMerge: "medium" }, pack: pack("high") });
    expect(await none.run()).toMatchObject({ detail: { merged: { by: "person" } } });
    expect(calls(none.github, "mergePr")).toEqual([]);
    expect(none.notes.join("\n")).toMatch(/ship approver/);

    const approved = setup({}, { policy: { autoMerge: "medium" }, pack: pack("high"), approvals: [{ kind: "awaiting_ship", decision: "approved", response: { approver: "bo" } } as never] });
    expect(await approved.run()).toMatchObject({ detail: { merged: { by: "machine" } } });
  });

  it("waits through a freeze window and merges after it", async () => {
    const freeze = [{ from: "2026-11-04T00:00:00Z", to: "2026-11-04T12:03:00Z", reason: "release week" }];
    const { run, github, slept, notes } = setup({}, { policy: { autoMerge: "low", freeze } });
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" } } });
    expect(slept).toEqual([60_000, 60_000, 60_000]);
    expect(calls(github, "mergePr")).toHaveLength(1);
    expect(notes.filter((n) => /freeze: release week/.test(n))).toHaveLength(1);
  });

  it("waits for a PR it depends on, and merges when that one is merged or closed", async () => {
    let seven = 0;
    const { run, notes } = setup(
      { prFacts: async () => node({ body: "Depends on #7" }), prMerged: async (_slug, n) => (n === 7 ? (++seven < 2 ? open : merged) : open) },
      { policy: { autoMerge: "low" } },
    );
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" } } });
    expect(notes.join("\n")).toMatch(/blocked by #7/);
  });

  it("waits for a CODEOWNERS approval the machine reads itself, and merges once an owner approved the head", async () => {
    let reviews = 0;
    const { run, github, notes } = setup(
      {
        prFiles: async () => [{ path: "src/a.ts", additions: 1, deletions: 0 }],
        prReviews: async () => (++reviews < 2 ? [] : [{ author: "Ana", state: "APPROVED", commitId: HEAD, at: "t" }]),
      },
      { policy: { autoMerge: "low" }, codeowners: "src/ @ana\n" },
    );
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" } } });
    expect(notes.join("\n")).toMatch(/no owner of src\/a.ts approved \(@ana\)/);
    expect(calls(github, "mergePr")).toHaveLength(1);
  });

  it("names a team it cannot resolve as a blocker instead of passing it", async () => {
    const { run, notes } = setup(
      { prFiles: async () => [{ path: "src/a.ts", additions: 1, deletions: 0 }], prReviews: async () => [], teamMembers: async () => Promise.reject(new Error("403")), prMerged: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(merged) },
      { policy: { autoMerge: "low" }, codeowners: "src/ @acme/core\n" },
    );
    await run();
    expect(notes.join("\n")).toMatch(/owner @acme\/core cannot be resolved/);
  });

  it("asks the merge queue once: a PR sitting in the queue is not merged again, and a merge seen later is the machine's", async () => {
    let polls = 0;
    const mergePr = vi.fn(async () => ({ queued: true as const }));
    const { run, github } = setup({ mergePr, prMerged: async () => (++polls < 4 ? open : merged) }, { policy: { autoMerge: "low" } });
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" } } });
    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(await loadCursor(stateDir, "t1")).toMatchObject({ queued: true });
    expect(calls(github, "mergePr")).toHaveLength(1);
  });

  it("reads CODEOWNERS at the PR's base branch through the port, never from the worktree", async () => {
    const fileAtRef = vi.fn(async (_slug: string, _ref: string, path: string) => (path === "CODEOWNERS" ? "src/ @ana\n" : null));
    const github = fakeGitHub({ fileAtRef, prMerged: async () => open, prFacts: async () => node(), prHeadSha: async () => HEAD, prActivity: async () => [], mergePr: async () => {}, prFiles: async () => [{ path: "src/a.ts", additions: 1, deletions: 0 }], prReviews: async () => [{ author: "ana", state: "APPROVED", commitId: HEAD, at: "t" }] });
    const result = await shipMonitor({
      github,
      policies: { for: async () => ({ ...DEFAULT_POLICY, autoMerge: "low" as const }) },
      evidence: { load: async () => pack() },
      stateDir,
      pollMs: 1,
      sleep: async () => {},
    })({ task: { id: "t2", repoPath: "/r", worktreePath: "/nonexistent" }, approvals: [], signal: new AbortController().signal } as unknown as StageContext, REF);
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" } } });
    expect(fileAtRef.mock.calls.map((c) => [c[1], c[2]])).toEqual([["main", ".github/CODEOWNERS"], ["main", "CODEOWNERS"]]);
  });

  it("never merges a PR that changes a CODEOWNERS file, or one with no evidence pack", async () => {
    const touching = setup({ prFiles: async () => [{ path: ".github/CODEOWNERS", additions: 1, deletions: 0 }], prMerged: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(merged) }, { policy: { autoMerge: "low" } });
    expect(await touching.run()).toMatchObject({ detail: { merged: { by: "person" } } });
    expect(calls(touching.github, "mergePr")).toEqual([]);
    expect(touching.notes.join("\n")).toMatch(/changes CODEOWNERS/);
    const bare = setup({ prMerged: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(merged) }, { policy: { autoMerge: "medium" }, pack: null });
    expect(await bare.run()).toMatchObject({ detail: { merged: { by: "person" } } });
    expect(calls(bare.github, "mergePr")).toEqual([]);
    expect(bare.notes.join("\n")).toMatch(/no evidence pack/);
  });

  it("turns a CODEOWNERS rule it will not match into an unresolved-owner blocker", async () => {
    const codeowners = `${"*a".repeat(17)} @ana\n`;
    const { run, notes } = setup({ prMerged: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(merged), prFiles: async () => [{ path: "a.ts", additions: 1, deletions: 0 }] }, { policy: { autoMerge: "low" }, codeowners });
    await run();
    expect(notes.join("\n")).toMatch(/too complex to match/);
  });

  it("checks at most ten dependencies and blocks a PR that lists more", async () => {
    const body = Array.from({ length: 11 }, (_, i) => `Depends on #${100 + i}`).join("\n");
    const prMerged = vi.fn(async () => open);
    const { run, notes } = setup({ prFacts: async () => node({ body }), prMerged }, { policy: { autoMerge: "low" }, maxWaitMs: 90_000 });
    await run();
    expect(notes.join("\n")).toMatch(/too many dependencies listed \(11\)/);
    // per poll: one state read of the PR itself and ten dependencies, never the eleventh
    expect(prMerged.mock.calls.filter((c) => (c as unknown as [string, number])[1] === 110)).toEqual([]);
  });

  it("asks for a team's members again after ten minutes, so a removed member stops counting", async () => {
    let members = ["ana"];
    const teamMembers = vi.fn(async () => members);
    let polls = 0;
    const { run, notes } = setup(
      {
        teamMembers,
        prFiles: async () => [{ path: "src/a.ts", additions: 1, deletions: 0 }],
        prReviews: async () => [{ author: "ana", state: "APPROVED", commitId: HEAD, at: "t" }],
        prMerged: async () => {
          // after the 10th poll the team loses ana; the 13th poll (> 10 minutes after the first fetch) sees it
          if (++polls === 10) members = [];
          return polls > 13 ? merged : open;
        },
      },
      { policy: { autoMerge: "off" }, codeowners: "src/ @acme/core\n" },
    );
    await run();
    expect(teamMembers.mock.calls.length).toBe(2);
    expect(notes.join("\n")).toMatch(/no owner of src\/a.ts approved \(@acme\/core\)/);
  });

  it("escalates head_moved when the head is not the commit the pack shows", async () => {
    const { run, github } = setup({}, { policy: { autoMerge: "low" }, pack: pack("low", "1111111aaaa") });
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { escalation: "head_moved" } });
    expect(calls(github, "mergePr")).toEqual([]);
  });

  it("escalates a PR closed without a merge", async () => {
    const { run } = setup({ prMerged: async () => ({ merged: false, mergedSha: null, state: "closed", mergedAt: null }) });
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: "the PR was closed without a merge" } });
  });

  it("escalates after the longest wait", async () => {
    const { run } = setup({}, { maxWaitMs: 5 * 60_000 });
    const result = await run();
    expect(result).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringMatching(/the PR has waited/) } });
  });

  it("fails as aborted when the task is aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await setup({}, { abort }).run()).toEqual({ outcome: "fail", detail: { error: "aborted" } });
  });

  it("retries a failed merge once on the next poll, then escalates with GitHub's words", async () => {
    const mergePr = vi.fn().mockRejectedValue(new Error("merging o/a#3 failed (409): Head branch was modified"));
    const { run, notes } = setup({ mergePr }, { policy: { autoMerge: "low" } });
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("Head branch was modified") } });
    expect(mergePr).toHaveBeenCalledTimes(2);
    expect(notes.join("\n")).toMatch(/the merge failed/);
  });

  it("goes on polling when GitHub fails a read", async () => {
    const { run, notes } = setup({ prMerged: vi.fn().mockRejectedValueOnce(new Error("502")).mockResolvedValue(merged) });
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "person" } } });
    expect(notes.join("\n")).toMatch(/could not read the PR: 502/);
  });

  it("records new activity in the cursor and notes it once, asking GitHub only for what is after `since`", async () => {
    const item = { id: "comment:1", kind: "comment" as const, actor: "ana", isBot: false, body: "why?", state: null, at: "2026-11-04T12:01:00Z", url: null };
    const prActivity = vi.fn(async (_s: string, _n: number, since: string | null) => (since ? [] : [item]));
    const { run, notes } = setup({ prActivity, prMerged: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(open).mockResolvedValueOnce(merged) });
    await run();
    expect(notes.filter((n) => /new item/.test(n))).toEqual(["1 new item on the PR: ana comment"]);
    expect(prActivity.mock.calls.map((c) => c[2])).toEqual([null, "2026-11-04T12:01:00Z"]);
    expect(await loadCursor(stateDir, "t1")).toMatchObject({ since: "2026-11-04T12:01:00Z", seen: ["comment:1"] });
  });

  it("reads the cursor a previous run left: its merge request and its start time", async () => {
    await saveCursor(stateDir, "t1", { ...emptyCursor({ slug: "o/a", number: 3 }), since: "2026-11-04T11:00:00Z", seen: ["comment:1"], startedAt: START.toISOString(), mergeRequested: true });
    const { run } = setup({ prMerged: async () => merged });
    // a merge the earlier run had asked for is the machine's
    expect(await run()).toMatchObject({ detail: { merged: { by: "machine" } } });
    expect((await loadCursor(stateDir, "t1"))!.startedAt).toBe(START.toISOString());
  });

  it("passes the cursor's since to the activity read", async () => {
    await saveCursor(stateDir, "t1", { ...emptyCursor({ slug: "o/a", number: 3 }), since: "2026-11-04T11:00:00Z", startedAt: START.toISOString() });
    const prActivity = vi.fn(async () => []);
    const { run } = setup({ prActivity }, { policy: { autoMerge: "low" } });
    await run();
    expect(prActivity).toHaveBeenCalledWith("o/a", 3, "2026-11-04T11:00:00Z");
  });
});

describe("the review loop", () => {
  it("answers a person's question from the pack: pr_reply runs with the thread, the reply lands on it, nothing is resolved", async () => {
    const at = "2026-11-04T12:01:00Z";
    const question = "Does the export handle an empty cart?";
    const thread = { id: "T1", path: "src/export.ts", line: 12, comments: [{ author: "bo", body: question, at }] };
    const reply = "Yes: scenario 2 exports an empty cart and gets an empty file.";
    let polls = 0;
    const decide = vi.fn(async (pack: string, _ship: unknown, _repo: unknown) => (pack === "event_class" ? { event: { choice: "comment", confidence: 0.95 } } : { intent: { choice: "question", confidence: 0.9 } }));
    const runPack = vi.fn(async (_pack: string, _context: unknown, _extra: unknown) => ({ outcome: "pass" as const, detail: { answer: { reply, resolves: false, confidence: 0.9 } } }));
    const { run, github } = setup(
      {
        viewer: async () => ({ login: "me", teams: [] }),
        prMerged: async () => (++polls < 3 ? open : merged),
        prActivity: async (_slug, _n, since) => (since === null ? [{ id: "review_comment:1", kind: "review_comment", actor: "bo", isBot: false, body: question, state: null, at, url: null }] : []),
        prThreads: async () => [thread],
        replyToThread: async () => {},
      },
      { loop: { decide, runPack } },
    );
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "person" } } });
    expect(decide.mock.calls.map((c) => c[0])).toEqual(["event_class", "comment_intent"]);
    expect(decide.mock.calls[0]![1]).toMatchObject({ kind: "event", event: { actor: "bo", isBot: false, isMe: false, kind: "comment", body: question } });
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(runPack.mock.calls[0]![0]).toBe("pr_reply");
    expect(runPack.mock.calls[0]![2]).toMatchObject({ kind: "comment", comment: { thread, pack: { summary: "s", howToVerify: "h" }, myReplies: 0 } });
    expect(calls(github, "replyToThread")).toEqual([["replyToThread", "T1", reply]]);
    expect(calls(github, "resolveThread")).toEqual([]);
  });
});

/** The loop's world: a worktree whose head moves when addressing "commits", decisions by table, and every sub-run recorded. */
function loopWorld(over: { choices?: Record<string, string>; confidence?: number; addressed?: Record<string, unknown>; checks?: object; ciVerdict?: Record<string, unknown>; replyConfidence?: number } = {}) {
  const NEW = "e".repeat(40);
  let head = HEAD;
  const git: string[][] = [];
  const exec: GitExec = async (_c, args) => {
    const a = args.slice(args.indexOf("-C") + 2);
    git.push(a);
    const out = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (a[0] === "rev-parse") return out(head);
    if (a[0] === "reset") {
      head = a[3]!;
      return out();
    }
    if (a[0] === "diff" && a[1] === "--name-only") return out("src/export.ts\n");
    return out();
  };
  const choices: Record<string, string> = { event_class: "comment", comment_intent: "question", fix_scope: "in_place", evidence_valid: "refresh_text", ...over.choices };
  const key: Record<string, string> = { event_class: "event", comment_intent: "intent", fix_scope: "scope", evidence_valid: "validity" };
  const decide = vi.fn(async (pack: string, _ship: unknown, _repo: unknown) => ({ [key[pack]!]: { choice: choices[pack], confidence: over.confidence ?? 0.95 } }));
  const runPack = vi.fn(async (pack: string, _context: unknown, _extra: unknown) => {
    if (pack === "pr_reply") return { outcome: "pass" as const, detail: { answer: { reply: "See scenario 1.", resolves: true, confidence: over.replyConfidence ?? 0.9 } } };
    if (pack === "addressing") {
      head = NEW;
      return { outcome: "pass" as const, detail: over.addressed ?? { answer: { kind: "done", summary: "renamed x", replies: [{ threadId: "T1", body: "Renamed.", resolve: true }] } } };
    }
    if (pack === "ci_watch") return { outcome: "pass" as const, detail: { answer: over.ciVerdict ?? { verdict: "fixable", summary: "the lint step fails", findings: [] } } };
    return { outcome: "pass" as const, detail: {} };
  });
  const checks = vi.fn(async (_context: unknown, _since: string) => (over.checks ?? { outcome: "pass", detail: {} }) as never);
  const rebase = vi.fn(async () => {
    head = "f".repeat(40);
    return { ok: true as const, onto: "origin/main" };
  });
  const saved: EvidencePack[] = [];
  const publish = vi.fn(async ({ pack: p }: { pack: EvidencePack }) => ({ pack: p, comment: "updated" as const, assets: 0 }));
  const evidence = { save: async (_id: string, p: EvidencePack) => void saved.push(p), publish, store: { dirFor: (id: string, sha: string) => `/ev/${id}/${sha}` } };
  const loop: ReviewLoop = { decide, runPack, checks, exec, rebase };
  return { loop, evidence, decide, runPack, checks, rebase, saved, publish, git, NEW, pushes: () => git.filter((a) => a[0] === "push") };
}

const ACTIVITY_AT = "2026-11-04T12:01:00Z";
const commentAct = (over: Record<string, unknown> = {}) => ({ id: "review_comment:1", kind: "review_comment" as const, actor: "bo", isBot: false, body: "please rename x", state: null, at: ACTIVITY_AT, url: null, ...over });
const threadOf = (over: Record<string, unknown> = {}) => ({ id: "T1", path: "src/export.ts", line: 12, comments: [{ author: "bo", body: "please rename x", at: ACTIVITY_AT }], ...over });
const redNode = () => node({ commits: { nodes: [{ commit: { oid: HEAD, committedDate: "2026-11-03T10:00:00Z", statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: null }] } } } }] } });
const failedCheck = (run = 77) => [{ name: "build", state: "FAILURE", link: `https://github.com/o/a/actions/runs/${run}/job/1` }];

/** Runs one activity item through the monitor until a person merges. */
function review(world: ReturnType<typeof loopWorld>, answers: Partial<GitHub> = {}, activity = [commentAct()], over: Parameters<typeof setup>[1] = {}) {
  let polls = 0;
  return setup(
    {
      prMerged: async () => (++polls < 3 ? open : merged),
      prActivity: async (_slug, _n, since) => (since === null ? activity : []),
      prThreads: async () => [threadOf()],
      replyToThread: async () => {},
      resolveThread: async () => {},
      threadResolved: async () => false,
      commentOnIssue: async () => {},
      ...answers,
    },
    { loop: world.loop, evidence: world.evidence, ...over },
  );
}

describe("the review loop: events", () => {
  it("lets a bot's comment pass as noise: nothing posted, nothing run, and it is not asked about again", async () => {
    const world = loopWorld({ choices: { event_class: "noise" } });
    const { run, github } = review(world, {}, [commentAct({ actor: "ci-bot", isBot: true, body: "coverage 91%" })]);
    expect(await run()).toMatchObject({ outcome: "pass" });
    expect(world.decide.mock.calls.map((c) => c[0])).toEqual(["event_class"]);
    expect(world.decide.mock.calls[0]![1]).toMatchObject({ event: { actor: "ci-bot", isBot: true, isMe: false } });
    expect(world.runPack).not.toHaveBeenCalled();
    expect(calls(github, "replyToThread")).toEqual([]);
    expect((await loadCursor(stateDir, "t1"))!.seen).toEqual(["review_comment:1"]);
  });

  it("skips the monitor's own comments without asking anyone", async () => {
    const world = loopWorld();
    const { run } = review(world, {}, [commentAct({ actor: "Me", body: "the evidence comment" })]);
    await run();
    expect(world.decide).not.toHaveBeenCalled();
  });

  it("asks a person when event_class is not sure enough, naming who did what", async () => {
    const world = loopWorld({ confidence: 0.2 });
    const { run } = review(world);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringMatching(/needs a person.*bo review_comment: please rename x/) } });
  });

  it("asks a person when the decision cannot run at all (no model): never noise", async () => {
    const world = loopWorld();
    const { run } = review({ ...world, loop: { ...world.loop, decide: null } });
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("no model is available") } });
  });

  it("answers a top-level conversation comment with a conversation comment, never a thread reply", async () => {
    const world = loopWorld();
    const { run, github } = review(world, { prThreads: async () => [] }, [commentAct({ id: "comment:9", kind: "comment", body: "Is this safe to roll back?" })]);
    await run();
    expect(calls(github, "commentOnIssue")).toEqual([["commentOnIssue", "o/a", 3, "See scenario 1."]]);
    expect(calls(github, "replyToThread")).toEqual([]);
  });

  it("does not post an answer it is not confident in: a person answers", async () => {
    const world = loopWorld({ replyConfidence: 0.2 });
    const { run, github } = review(world);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("not confident enough") } });
    expect(calls(github, "replyToThread")).toEqual([]);
  });
});

describe("the review loop: fixes", () => {
  it("fixes a change request in place: addressing, checks, push, reply and resolve, the pack re-stamped and republished", async () => {
    const world = loopWorld({ choices: { comment_intent: "change_request" } });
    const { run, github } = review(world);
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { by: "person" } } });
    expect(world.runPack.mock.calls.map((c) => c[0])).toEqual(["addressing"]);
    expect(world.checks).toHaveBeenCalledWith(expect.anything(), HEAD);
    expect(world.pushes()).toEqual([["push", "-u", "origin", "hardness/t1"]]);
    expect(calls(github, "replyToThread")).toEqual([["replyToThread", "T1", "Renamed."]]);
    expect(calls(github, "resolveThread")).toEqual([["resolveThread", "T1"]]);
    expect(world.decide.mock.calls.map((c) => c[0])).toEqual(["event_class", "comment_intent", "fix_scope", "evidence_valid"]);
    expect(world.saved[0]).toMatchObject({ commitSha: world.NEW, summary: expect.stringContaining("Fixed after review:") });
    expect(world.publish).toHaveBeenCalledTimes(1);
    const cursor = (await loadCursor(stateDir, "t1"))!;
    expect(cursor.fixRounds).toBe(1);
    expect(cursor.threads.T1).toMatchObject({ replies: 1, fixRounds: 1 });
  });

  it("treats a nit as an in-place fix without asking fix_scope", async () => {
    const world = loopWorld({ choices: { comment_intent: "nit" } });
    const { run } = review(world);
    await run();
    expect(world.decide.mock.calls.map((c) => c[0])).not.toContain("fix_scope");
    expect(world.runPack.mock.calls.map((c) => c[0])).toEqual(["addressing"]);
  });

  it("has the verifier review the delta (the head before the fix as its base) on a re_verify_partial scope", async () => {
    const world = loopWorld({ choices: { comment_intent: "change_request", fix_scope: "re_verify_partial" } });
    const { run } = review(world);
    await run();
    const verifying = world.runPack.mock.calls.find((c) => c[0] === "verifying");
    expect(verifying![2]).toEqual({ baseCommit: HEAD });
  });

  it("resets and asks a person when the checks fail after the fix: nothing is pushed or posted", async () => {
    const world = loopWorld({ choices: { comment_intent: "change_request" }, checks: { outcome: "fail", detail: { error: "`pnpm test` failed" } } });
    const { run, github } = review(world);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("checks failed after the fix") } });
    expect(world.git.filter((a) => a[0] === "reset").map((a) => a[3])).toEqual([HEAD]);
    expect(world.pushes()).toEqual([]);
    expect(calls(github, "replyToThread")).toEqual([]);
  });

  it("asks a person about a third round trip on one thread, before any model is asked about it", async () => {
    const world = loopWorld({ choices: { comment_intent: "change_request" } });
    const thread = threadOf({ comments: [{ author: "bo", body: "please rename x", at: ACTIVITY_AT }, { author: "me", body: "Done.", at: "t" }, { author: "bo", body: "again", at: "t2" }, { author: "me", body: "Done again.", at: "t3" }] });
    const act = commentAct({ body: "please rename x" });
    const { run } = review(world, { prThreads: async () => [thread] }, [act]);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("third round trip on src/export.ts") } });
    expect(world.decide.mock.calls.map((c) => c[0])).toEqual(["event_class"]);
    expect(world.runPack).not.toHaveBeenCalled();
  });

  it("asks a person when the PR has already had three fix rounds", async () => {
    const world = loopWorld({ choices: { comment_intent: "change_request" } });
    await saveCursor(stateDir, "t1", { ...emptyCursor({ slug: "o/a", number: 3 }), fixRounds: 3 });
    const { run } = review(world);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("3 fix rounds are spent") } });
    expect(world.runPack).not.toHaveBeenCalled();
  });

  it("asks a person on a disagreement, quoting the thread", async () => {
    const world = loopWorld({ choices: { comment_intent: "disagreement" } });
    const { run } = review(world);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining('a reviewer disagrees: src/export.ts:12: bo: "please rename x"') } });
  });

  it("sends a change that needs a new plan back to triage, with the thread quoted", async () => {
    const world = loopWorld({ choices: { comment_intent: "change_request", fix_scope: "re_plan" } });
    const { run } = review(world);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { escalation: "plan_wrong", reason: expect.stringContaining("please rename x") } });
  });
});

describe("the review loop: CI and conflicts", () => {
  const ciWorld = (verdict: Record<string, unknown>) => loopWorld({ ciVerdict: verdict });
  const redPr = (extra: Partial<GitHub> = {}): Partial<GitHub> => ({
    prFacts: async () => redNode(),
    prChecks: async () => failedCheck(),
    failedRunLog: async () => "lint failed",
    findPr: async () => ({ number: 3, url: REF.url, isDraft: false }) as never,
    rerunFailedJobs: async () => {},
    ...extra,
  });

  it("turns a fixable red CI into a fix round with the findings as the thread, and posts no reply", async () => {
    const world = ciWorld({ verdict: "fixable", summary: "the lint step fails", findings: [{ title: "no-unused", body: "x is unused" }] });
    const { run, github } = review(world, redPr(), []);
    await run();
    expect(world.runPack.mock.calls.map((c) => c[0])).toEqual(["ci_watch", "addressing"]);
    expect(world.runPack.mock.calls[0]![2]).toMatchObject({ ci: { logs: "lint failed", checks: [{ name: "build", state: "FAILURE" }] } });
    expect(world.runPack.mock.calls[1]![2]).toMatchObject({ threads: { threads: [{ id: "ci", comments: [{ author: "ci", body: expect.stringContaining("no-unused") }] }] } });
    expect(world.pushes()).toHaveLength(1);
    expect(calls(github, "replyToThread")).toEqual([]);
  });

  it("re-runs a flake once; the same red again goes to a person", async () => {
    const world = ciWorld({ verdict: "flake", summary: "a timeout" });
    let run = 77;
    const { run: go, github } = review(world, redPr({ prChecks: async () => failedCheck(run++) }), []);
    expect(await go()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("red again after one re-run") } });
    expect(calls(github, "rerunFailedJobs")).toEqual([["rerunFailedJobs", "o/a", "77"]]);
    expect((await loadCursor(stateDir, "t1"))!.ciReruns).toBe(1);
  });

  it("asks a person for an infra red, with the pack's reason, and asks the pack once per red", async () => {
    const world = ciWorld({ verdict: "infra", summary: "s", reason: "the registry is down" });
    const { run } = review(world, redPr(), []);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("the registry is down"), verdict: "infra" } });
    expect(world.runPack).toHaveBeenCalledTimes(1);
  });

  it("rebases a conflicting branch once with a lease, re-stamps the pack, and asks a person the second time", async () => {
    const world = loopWorld();
    const { run } = review(world, { prFacts: async () => node({ mergeable: "CONFLICTING" }), prMerged: async () => open }, []);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { verdict: "conflict_unresolvable", reason: expect.stringContaining("after one rebase") } });
    expect(world.rebase).toHaveBeenCalledTimes(1);
    expect(world.pushes()).toEqual([["push", "--force-with-lease", "-u", "origin", "hardness/t1"]]);
    expect(world.saved[0]).toMatchObject({ commitSha: "f".repeat(40) });
    expect((await loadCursor(stateDir, "t1"))!.rebases).toBe(1);
  });

  it("asks a person when the rebase stops on a conflict", async () => {
    const world = loopWorld();
    const rebase = vi.fn(async () => ({ ok: false as const, error: "conflict", conflicts: ["a.ts"] }));
    const { run } = review({ ...world, loop: { ...world.loop, rebase } }, { prFacts: async () => node({ mergeable: "CONFLICTING" }), prMerged: async () => open }, []);
    expect(await run()).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("rebase stops on: a.ts") } });
    expect(world.pushes()).toEqual([]);
  });
});
