import type { PlanContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { ApprovalRow } from "../../domain/task.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type BuildTestsDeps, buildTestsStep } from "./build-tests.ts";
import type { SweepOutcome } from "./sweep.ts";

const gate = (requested: Record<string, unknown>): ApprovalRow =>
  ({ id: "a", taskId: "t", kind: "awaiting_approval", requested, decision: "approved", reason: null, response: null, createdAt: new Date(0), decidedAt: new Date(0) }) as ApprovalRow;
const v1 = gate({ brief: "b", criteria: ["c1"], slices: [], cases: [{ title: "one", criterion: "c1", approach: "a" }, { title: "two", criterion: "c1", approach: "b" }] });
const v2 = gate({
  plan: { goal: "g", steps: [], acceptance_criteria: [{ id: "C1", text: "c1" }], out_of_scope: [], assumptions: [], rollback: "r", version: 3 },
  cases: [{ id: "S1", title: "one", criterion: "c1", criterion_ref: "C1", approach: "a" }],
});
const context = (approvals: ApprovalRow[], over: Record<string, unknown> = {}): StageContext =>
  ({ task: { id: "abcdef12-0000", route: "feature", repoPath: "/r", worktreePath: "/w" }, stage: "implementing", attempt: 1, runId: "r1", approvals, signal: new AbortController().signal, ...over }) as unknown as StageContext;

const tagged = (...ids: string[]) => ({ nameStatus: "A\tweb/cart.test.ts", diff: ["diff --git a/web/cart.test.ts b/web/cart.test.ts", "--- /dev/null", "+++ b/web/cart.test.ts", "@@ -0,0 +1 @@", ...ids.map((id) => `+it("x @scenario:${id}", () => {})`)].join("\n") });

/** Fakes: the writer leaves the next queued working tree; the git calls and the implementer are recorded in order. */
const allRed = { S1: "FAIL: cart.export is not a function", S2: "FAIL: cart.total is not a function" };
const sweeps: SweepOutcome[] = [];
function fakes(trees: Array<{ nameStatus: string; diff: string }>, over: Partial<BuildTestsDeps> = {}, reds: Array<Record<string, string>> = [allRed]) {
  const calls: string[] = [];
  const reviews: Array<string[] | undefined> = [];
  const implemented: Array<{ scenarioTests?: { scenario: string; file: string }[] }> = [];
  let tree = trees[0]!;
  let commit: { subject: string; body: string } | null = null;
  const deps: BuildTestsDeps = {
    implement: async (_c, extra) => {
      calls.push("implement");
      implemented.push(extra);
      return { outcome: "pass" } as StageResult;
    },
    sweep: async () => {
      calls.push("sweep");
      return sweeps.length ? sweeps.shift()! : { status: "passed", ran: ["lint"], failed: [] };
    },
    runWriter: async (_c, extra: { plan?: PlanContext }) => {
      calls.push("writer");
      reviews.push(extra.plan?.review);
      tree = trees[Math.min(reviews.length - 1, trees.length - 1)]!;
      return { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/w" }, detail: { scenarioReds: reds[Math.min(reviews.length - 1, reds.length - 1)] } };
    },
    judgeRed: async () => ({ verdict: "proceed", problems: [] }),
    checkpoint: async (_c, _where, follows) => void calls.push(`checkpoint:${follows}`),
    holdout: async () => false,
    git: {
      pending: async () => tree,
      commit: async (_p, subject, body) => {
        calls.push("commit");
        commit = { subject, body };
        return "abc1234";
      },
      discard: async () => void calls.push("discard"),
      findTestsCommit: async () => null,
    },
    ...over,
  };
  return { deps, calls, reviews, implemented, commit: () => commit };
}

describe("the red check, per scenario", () => {
  const emitted = () => {
    const rows: Array<[string, Record<string, unknown>]> = [];
    return { rows, emit: async (kind: string, payload: Record<string, unknown>) => void rows.push([kind, payload]) };
  };

  it("asks red_check about each scenario with the fact that its tagged test exists and the writer's failing output, and puts a scenario.red row with the id on the stream", async () => {
    const asked: unknown[] = [];
    const f = fakes([tagged("S1", "S2")], { judgeRed: async (check) => (asked.push(check), { verdict: "proceed", problems: [] }) });
    const e = emitted();
    await buildTestsStep(f.deps)(context([v1], { emit: e.emit }));
    expect(asked).toMatchObject([
      { kind: "red", scenario: { id: "S1" }, exists: true, output: allRed.S1 },
      { kind: "red", scenario: { id: "S2" }, exists: true, output: allRed.S2 },
    ]);
    expect(e.rows).toEqual([["scenario.red", { scenario: "S1" }], ["scenario.red", { scenario: "S2" }]]);
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
  });

  it("sends the writer back with the problems of a scenario whose test fails for the wrong reason", async () => {
    let n = 0;
    const f = fakes([tagged("S1", "S2")], { judgeRed: async (c) => (c.scenario?.id === "S2" && n++ === 0 ? { verdict: "flag", problems: ["the test fails on an import"] } : { verdict: "proceed", problems: [] }) });
    await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(f.reviews[1]!.join(" ")).toMatch(/S2.*import/);
  });

  it("sends the writer back for a scenario with no red reported, twice at most, and escalates the third time", async () => {
    const f = fakes([tagged("S1", "S2")], {}, [{ S1: "FAIL" }]);
    const result = await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "writer", "writer", "discard"]);
    expect(f.reviews[1]!.join(" ")).toMatch(/S2.*red/);
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "other", reason: expect.stringMatching(/S2/) } });
  });

  it("does not block on a check that did not answer: skipped is flagged on the step", async () => {
    const f = fakes([tagged("S1")], { judgeRed: async () => ({ verdict: "skipped", problems: [] }) });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(result.detail).toMatchObject({ testsStep: { status: "committed", redCheck: "skipped" } });
  });
});

describe("the regression sweep in Build", () => {
  const failing: SweepOutcome = { status: "failed", ran: ["lint"], failed: [{ name: "lint", tail: "no-unused-vars at a.ts:3" }] };
  const emitted = () => {
    const rows: Array<[string, Record<string, unknown>]> = [];
    return { rows, emit: async (kind: string, payload: Record<string, unknown>) => void rows.push([kind, payload]) };
  };

  it("runs after the implementer's last slice is green, and its result rides on the stage", async () => {
    sweeps.length = 0;
    const f = fakes([tagged("S1")]);
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(result.detail).toMatchObject({ sweep: { status: "passed", ran: ["lint"] } });
  });

  it("runs the implementer again with the failing check's name and output, and counts the failed sweep as an iteration row", async () => {
    sweeps.length = 0;
    sweeps.push(failing);
    const f = fakes([tagged("S1")]);
    const e = emitted();
    const result = await buildTestsStep(f.deps)(context([v2], { emit: e.emit }));
    expect(f.calls.filter((c) => c === "implement")).toHaveLength(2);
    expect(f.implemented[1]).toMatchObject({ sweepFailures: [{ name: "lint", tail: "no-unused-vars at a.ts:3" }] });
    expect(e.rows.filter(([k]) => k === "build.sweep_failed")).toEqual([["build.sweep_failed", { checks: ["lint"] }]]);
    expect(result.outcome).toBe("pass");
  });

  it("does not pass the stage when the sweep still fails after two fix runs", async () => {
    sweeps.length = 0;
    sweeps.push(failing, failing, failing, failing);
    const f = fakes([tagged("S1")]);
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls.filter((c) => c === "implement")).toHaveLength(3);
    expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringMatching(/regression sweep failed: lint/), sweep: { status: "failed" } } });
  });

  it("says a repository with no checks was not swept, and leaves a PR route and a failing implementer unswept", async () => {
    sweeps.length = 0;
    sweeps.push({ status: "skipped", ran: [], failed: [], note: "the repository declares no checks" });
    const f = fakes([tagged("S1")]);
    expect((await buildTestsStep(f.deps)(context([v2]))).detail).toMatchObject({ sweep: { status: "skipped", note: expect.stringMatching(/no checks/) } });
    const g = fakes([tagged("S1")], { implement: async () => ({ outcome: "fail" }) as StageResult });
    await buildTestsStep(g.deps)(context([v2]));
    expect(g.calls).not.toContain("sweep");
    const h = fakes([tagged("S1")]);
    await buildTestsStep(h.deps)(context([v2], { task: { id: "abcdef12", route: "pr", repoPath: "/r", worktreePath: "/w" } }));
    expect(h.calls).not.toContain("sweep");
  });

  it("escalates when a check cannot run because the image lacks its tool", async () => {
    sweeps.length = 0;
    sweeps.push({ status: "failed", ran: ["lint"], failed: [{ name: "lint", tail: "x" }], missingTool: { cmd: "eslint .", tail: "eslint: not found" } });
    const f = fakes([tagged("S1")]);
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result).toMatchObject({ outcome: "escalated", detail: { envBroken: true, reason: expect.stringMatching(/cannot run.*eslint/) } });
    expect(f.calls.filter((c) => c === "implement")).toHaveLength(1);
  });
});

describe("Build's tests step", () => {
  it("runs the test writer, commits its tests with the plan's version, then runs the implementer with the tests listed by scenario", async () => {
    const f = fakes([tagged("S1")]);
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(f.commit()).toEqual({ subject: "test(abcdef12): scenarios", body: expect.stringMatching(/plan version 3/) });
    expect(f.implemented[0]!.scenarioTests).toEqual([{ scenario: "S1", file: "web/cart.test.ts" }]);
    expect(result.detail).toMatchObject({ testsStep: { status: "committed", commit: "abc1234" } });
  });

  it("sends the writer back once with the missing scenarios, and goes on when the second try tags them", async () => {
    const f = fakes([tagged("S1"), tagged("S1", "S2")]);
    await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(f.reviews[0]).toBeUndefined();
    expect(f.reviews[1]!.join(" ")).toMatch(/S2/);
  });

  it("escalates on a second miss, discards the working tree and never runs the implementer", async () => {
    const f = fakes([tagged("S1")]);
    const result = await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "writer", "discard"]);
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "other", reason: expect.stringMatching(/S2/) } });
  });

  it("refuses a production file in the tests step's diff", async () => {
    const dirty = { ...tagged("S1"), nameStatus: "A\tweb/cart.test.ts\nM\tsrc/cart.ts" };
    const f = fakes([dirty]);
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).not.toContain("commit");
    expect(f.calls).not.toContain("implement");
    expect(result.detail?.reason).toMatch(/src\/cart\.ts/);
  });

  it("skips the step under holdout_cases and says so", async () => {
    const f = fakes([tagged("S1")], { holdout: async () => true });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).toEqual(["implement", "sweep"]);
    expect(result.detail).toMatchObject({ testsStep: { status: "skipped", why: "holdout_cases" } });
  });

  it("adds the writer's usage to the run's, so the budget counts the tests step's tokens and turns", async () => {
    const f = fakes([tagged("S1")], {
      runWriter: async () => ({ outcome: "pass", detail: { scenarioReds: { S1: "FAIL" } }, usage: { turns: 4, costUsd: 0.25, tokens: { input: 100, output: 20 } } }) as StageResult,
      implement: async () => ({ outcome: "pass", usage: { turns: 10, costUsd: 1, tokens: { input: 1000, output: 200 } } }) as StageResult,
    });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result.usage).toEqual({ turns: 14, costUsd: 1.25, tokens: { input: 1100, output: 220 } });
  });

  it("leaves a PR route and a resumed run alone", async () => {
    const f = fakes([tagged("S1")]);
    await buildTestsStep(f.deps)(context([v2], { task: { id: "abcdef12", route: "pr", repoPath: "/r", worktreePath: "/w" } }));
    await buildTestsStep(f.deps)(context([v2], { resume: { container: "c", inputCommit: null } }));
    expect(f.calls).toEqual(["implement", "implement", "sweep"]);
  });

  it("does not write the tests twice: a card whose tests commit exists goes straight to the implementer, with the tests listed from that commit", async () => {
    const f = fakes([tagged("S1")], { git: { ...fakes([]).deps.git, findTestsCommit: async () => ({ sha: "def5678", ...tagged("S1") }) } });
    await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).toEqual(["implement", "sweep"]);
    expect(f.implemented[0]!.scenarioTests).toEqual([{ scenario: "S1", file: "web/cart.test.ts" }]);
  });

  it("passes a writer's failure or usage limit straight up", async () => {
    const f = fakes([tagged("S1")], { runWriter: async () => ({ outcome: "fail", rateLimited: true }) as StageResult });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result).toMatchObject({ rateLimited: true });
    expect(f.calls).toEqual([]);
  });
});
