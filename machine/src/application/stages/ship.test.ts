import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { type ShipDeps, shipRunnerWith } from "./ship.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function setup(github: ReturnType<typeof fakeGitHub>) {
  const exec = vi.fn(async (_command: string, _args: string[]) => ok());
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow,
    stage: "shipping",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: shipRunnerWith({ exec, github, slugOf: async () => "a/b" }), context, exec };
}
const pr = (isDraft: boolean) => ({ url: "https://x/pull/3", number: 3, isDraft });

describe("shipping", () => {
  it("pushes, then marks a draft PR ready", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), markPrReady: async () => {} });
    const { run, context, exec } = setup(github);
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/3", readied: true } });
    // One push, and the machine's note of it in the card's repository.
    expect(exec.mock.calls.filter((c) => !c[1].includes("update-ref"))).toHaveLength(1);
    expect(github.markPrReady).toHaveBeenCalledWith("a/b", 3);
  });

  it("does nothing to a PR that is already ready", async () => {
    const github = fakeGitHub({ findPr: async () => pr(false) });
    const { run, context } = setup(github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { readied: false } });
    expect(github.markPrReady).not.toHaveBeenCalled();
  });

  it("creates a non-draft PR when delivering never opened one", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "https://x/pull/9", number: 9, isDraft: false }) });
    const { run, context } = setup(github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/9", readied: false } });
    expect(github.openPr).toHaveBeenCalledWith("a/b", expect.objectContaining({ draft: false }));
  });

  it("fails with GitHub's words when marking ready fails", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), markPrReady: async () => { throw new Error("boom"); } });
    const { run, context } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("boom");
  });
});

describe("shipping with a monitor", () => {
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  const completePack = { summary: "s", format: "text" as const, scenarios: [{ text: "x", test: null, result: "pass" as const }], findings: [], outOfMap: [], risk: "low" as const, rollback: "r", howToVerify: "h", commitSha: HEAD, media: [], at: "2026-11-04T10:00:00.000Z" };
  const wire = async (over: { monitor?: ShipDeps["monitor"] } = {}) => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = await mkdtemp(join(tmpdir(), "ship-"));
    const github = fakeGitHub({ findPr: async () => pr(true), prHeadSha: async () => HEAD, markPrReady: async () => {}, prMerged: async () => ({ merged: false, mergedSha: null, state: "open", mergedAt: null }) });
    const publish = vi.fn(async () => ({ pack: completePack, comment: "created" as const, assets: 0 }));
    const evidence = { load: async () => completePack, save: async () => {}, publish, store: { dirFor: () => "/e" } };
    const monitor = over.monitor ?? vi.fn(async () => ({ outcome: "pass" as const, detail: { merged: { sha: "m1", at: null, by: "machine" }, prUrl: "https://x/pull/3", number: 3 } }));
    const context = { task: { id: "t1", title: "feat", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow, stage: "shipping", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
    const run = shipRunnerWith({ exec: vi.fn(async () => ok()), github, slugOf: async () => "a/b", evidence, headCommit: async () => HEAD, monitor, stateDir });
    return { run, context, publish, github, monitor: monitor as ReturnType<typeof vi.fn>, stateDir };
  };

  it("runs the monitor after the publish and the ready mark, and its result is the stage's, with what ship did beside it", async () => {
    const { run, context, publish, github, monitor } = await wire();
    const result = await run(context);
    expect(monitor).toHaveBeenCalledWith(context, { slug: "a/b", number: 3, url: "https://x/pull/3" });
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { by: "machine" }, readied: true, published: { assets: 0 } } });
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan((github.markPrReady as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect((github.markPrReady as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(monitor.mock.invocationCallOrder[0]!);
  });

  it("returns an escalation from the monitor as it is", async () => {
    const { run, context } = await wire({ monitor: async () => ({ outcome: "escalated", detail: { escalation: "head_moved", reason: "r", options: [] } }) });
    expect(await run(context)).toMatchObject({ outcome: "escalated", detail: { escalation: "head_moved" } });
  });

  it("on a restart finds the pack published on this head and goes straight to the monitor", async () => {
    const { run, context, publish, monitor } = await wire();
    await run(context);
    await run(context);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(monitor).toHaveBeenCalledTimes(2);
  });
});

describe("shipping after a restart", () => {
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  const cursorWith = async (extra: Record<string, unknown> = {}) => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { emptyCursor, saveCursor } = await import("../ship-cursor.ts");
    const stateDir = await mkdtemp(join(tmpdir(), "ship-r-"));
    await saveCursor(stateDir, "t1", { ...emptyCursor({ slug: "a/b", number: 3 }), published: { sha: HEAD }, ...extra });
    return stateDir;
  };
  const wire = async (state: { merged: boolean; mergedSha: string | null; state: "open" | "closed"; mergedAt: string | null }, extra: Record<string, unknown> = {}) => {
    const stateDir = await cursorWith(extra);
    const github = fakeGitHub({ prMerged: async () => state, findPr: async () => null, openPr: async () => { throw new Error("must not open a PR"); } });
    const exec = vi.fn(async () => ok());
    const monitor = vi.fn(async () => ({ outcome: "pass" as const, detail: { merged: { sha: "m2", at: null, by: "person" }, prUrl: "u", number: 3 } }));
    const context = { task: { id: "t1", title: "feat", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow, stage: "shipping", attempt: 2, runId: "r2", approvals: [], signal: new AbortController().signal } as StageContext;
    const run = shipRunnerWith({ exec, github, slugOf: async () => "a/b", headCommit: async () => HEAD, monitor, stateDir });
    return { run, context, exec, github, monitor };
  };

  it("passes at once for a PR already merged, without pushing the branch the merge deleted or opening another PR", async () => {
    const { run, context, exec, github, monitor } = await wire({ merged: true, mergedSha: "m1", state: "closed", mergedAt: "2026-11-04T12:00:00Z" }, { mergeRequested: true });
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { merged: { sha: "m1", by: "machine" }, number: 3 } });
    expect(exec).not.toHaveBeenCalled();
    expect(github.openPr).not.toHaveBeenCalled();
    expect(monitor).not.toHaveBeenCalled();
    const person = await wire({ merged: true, mergedSha: "m1", state: "closed", mergedAt: null });
    expect(await person.run(person.context)).toMatchObject({ detail: { merged: { by: "person" } } });
  });

  it("escalates a PR closed without a merge, and pushes nothing", async () => {
    const { run, context, exec } = await wire({ merged: false, mergedSha: null, state: "closed", mergedAt: null });
    expect(await run(context)).toMatchObject({ outcome: "escalated", detail: { reason: "the PR was closed without a merge" } });
    expect(exec).not.toHaveBeenCalled();
  });

  it("goes to the monitor with the cursor's PR for one still open, with no push (the pack is on this head) and no new PR", async () => {
    const { run, context, exec, github, monitor } = await wire({ merged: false, mergedSha: null, state: "open", mergedAt: null });
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { merged: { by: "person" } } });
    expect(exec).not.toHaveBeenCalled();
    expect(github.openPr).not.toHaveBeenCalled();
    expect(monitor).toHaveBeenCalledWith(context, { slug: "a/b", number: 3, url: "https://github.com/a/b/pull/3" });
  });
});

describe("shipping with an Evidence Pack", () => {
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  const pack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
    summary: "Show the cart total.",
    format: "captures",
    scenarios: [{ text: "Total shows", test: null, result: "pass" }],
    findings: [],
    outOfMap: [],
    risk: "low",
    rollback: "Revert.",
    howToVerify: "open it",
    commitSha: HEAD,
    media: [{ kind: "screenshot", label: "a.png", url: "https://github.com/o/a/releases/download/luna-evidence/a.png" }],
    at: "2026-11-04T10:00:00.000Z",
    ...over,
  });
  function withEvidence(loaded: EvidencePack | null, github: ReturnType<typeof fakeGitHub>, over: Partial<NonNullable<ShipDeps["evidence"]>> = {}, headCommit = async () => HEAD) {
    const saved: Array<[string, EvidencePack]> = [];
    const published = { pack: pack({ media: [{ kind: "screenshot", label: "a.png", url: "https://x/asset/a.png" }] }), comment: "created" as const, assets: 1 };
    const evidence = {
      load: vi.fn(async () => loaded),
      save: vi.fn(async (id: string, p: EvidencePack) => void saved.push([id, p])),
      publish: vi.fn(async () => published),
      store: { dirFor: (id: string, sha: string) => `/state/evidence/${id}/${sha}` },
      ...over,
    };
    const exec = vi.fn(async () => ok());
    const context = { task: { id: "t1", title: "feat", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow, stage: "shipping", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
    return { run: shipRunnerWith({ exec, github, slugOf: async () => "a/b", evidence, headCommit }), context, evidence, saved, published };
  }

  it("publishes a complete pack whose commit is the PR head, saves it with the asset urls, then marks the PR ready", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), prHeadSha: async () => HEAD, markPrReady: async () => {} });
    const { run, context, evidence, saved, published } = withEvidence(pack(), github);
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/3", readied: true, published: { comment: "created", assets: 1 } } });
    expect(evidence.publish).toHaveBeenCalledWith({ github, slug: "a/b", number: 3, taskId: "t1", pack: pack(), localDir: `/state/evidence/t1/${HEAD}` });
    expect(saved).toEqual([["t1", published.pack]]);
    expect(github.markPrReady).toHaveBeenCalledWith("a/b", 3);
    // Published before the PR leaves draft.
    expect((evidence.publish as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((github.markPrReady as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it("also publishes onto a PR that is already ready", async () => {
    const github = fakeGitHub({ findPr: async () => pr(false), prHeadSha: async () => HEAD });
    const { run, context, evidence } = withEvidence(pack(), github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { readied: false, published: { assets: 1 } } });
    expect(evidence.publish).toHaveBeenCalledTimes(1);
  });

  it("escalates head_moved, with no options and nothing published, when the head it just pushed is not the pack's commit", async () => {
    const moved = "fff9999000000000000000000000000000000000";
    const github = fakeGitHub({ findPr: async () => pr(true), prHeadSha: async () => moved, markPrReady: async () => {} });
    const { run, context, evidence } = withEvidence(pack(), github, {}, async () => moved);
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "head_moved", options: [], reason: expect.stringMatching(/abc1234.*fff9999.*Evidence runs again/) });
    expect(evidence.publish).not.toHaveBeenCalled();
    expect(github.markPrReady).not.toHaveBeenCalled();
  });

  it("trusts the head it pushed over GitHub's, which can lag the push: a differing GitHub head is a note, not a stop", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), prHeadSha: async () => "fff9999000000000000000000000000000000000", markPrReady: async () => {} });
    const { run, context, evidence } = withEvidence(pack(), github, {}, async () => HEAD);
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ published: { assets: 1 }, note: expect.stringMatching(/fff9999.*abc1234/) });
    expect(evidence.publish).toHaveBeenCalledTimes(1);
  });

  it("takes the worktree's head when GitHub names none", async () => {
    const github = fakeGitHub({ findPr: async () => pr(false), prHeadSha: async () => null });
    const same = withEvidence(pack(), github, {}, async () => HEAD);
    expect((await same.run(same.context)).outcome).toBe("pass");
    const moved = withEvidence(pack(), github, {}, async () => "eee5555000000000000000000000000000000000");
    expect((await moved.run(moved.context)).detail).toMatchObject({ escalation: "head_moved" });
  });

  it("fails naming what is missing from an incomplete pack, and publishes nothing", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), prHeadSha: async () => HEAD, markPrReady: async () => {} });
    const { run, context, evidence } = withEvidence(pack({ rollback: "", scenarios: [] }), github);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toMatch(/rollback/);
    expect(String(result.detail?.error)).toMatch(/scenarios/);
    expect(evidence.publish).not.toHaveBeenCalled();
    expect(github.markPrReady).not.toHaveBeenCalled();
  });

  it("ships as today, saying there was no pack, when the task has none", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), markPrReady: async () => {} });
    const { run, context, evidence } = withEvidence(null, github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { readied: true, evidence: "none" } });
    expect(evidence.publish).not.toHaveBeenCalled();
    expect(github.prHeadSha).not.toHaveBeenCalled();
  });

  it("fails with GitHub's words when publishing throws, and the PR stays a draft", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), prHeadSha: async () => HEAD, markPrReady: async () => {} });
    const { run, context } = withEvidence(pack(), github, { publish: vi.fn(async () => { throw new Error("uploading failed (422)"); }) });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("422");
    expect(github.markPrReady).not.toHaveBeenCalled();
  });

  it("publishes on the PR it opens when delivering never did", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "https://x/pull/9", number: 9, isDraft: false }), prHeadSha: async () => HEAD });
    const { run, context, evidence } = withEvidence(pack(), github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/9", published: { comment: "created" } } });
    expect(evidence.publish).toHaveBeenCalledWith(expect.objectContaining({ number: 9 }));
  });
});
