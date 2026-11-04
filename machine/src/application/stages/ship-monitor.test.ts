import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvidencePack } from "@hardness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY, type Policy } from "../../domain/policy.ts";
import type { PrNode } from "../../domain/pull-request.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { GitHub } from "../github.ts";
import type { StageContext } from "../ports.ts";
import { emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";
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

function setup(answers: Partial<GitHub> = {}, over: { policy?: Partial<Policy>; pack?: EvidencePack | null; approvals?: StageContext["approvals"]; maxWaitMs?: number; codeowners?: string | null; abort?: AbortController } = {}) {
  const github = fakeGitHub({ prMerged: async () => open, prFacts: async () => node(), prHeadSha: async () => HEAD, prActivity: async () => [], mergePr: async () => {}, ...answers });
  let clock = START.getTime();
  const slept: number[] = [];
  const notes: string[] = [];
  const deps: ShipMonitorDeps = {
    github,
    policies: { for: async () => ({ ...DEFAULT_POLICY, ...over.policy }) },
    evidence: { load: async () => (over.pack === undefined ? pack() : over.pack) },
    stateDir,
    pollMs: 60_000,
    ...(over.maxWaitMs !== undefined ? { maxWaitMs: over.maxWaitMs } : {}),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => new Date(clock),
    readCodeowners: async () => over.codeowners ?? null,
  };
  const context = {
    task: { id: "t1", repoPath: "/repo", worktreePath: "/wt", branch: "hardness/t1" },
    approvals: over.approvals ?? [],
    signal: (over.abort ?? new AbortController()).signal,
    note: async (text: string) => void notes.push(text),
  } as unknown as StageContext;
  return { run: () => shipMonitor(deps)(context, REF), github, slept, notes, advance: (ms: number) => void (clock += ms) };
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
