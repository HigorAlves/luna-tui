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
  const bases: Array<string> = [];
  let headValue = "base0";
  const headNow = () => headValue;
  const reviews: Array<string[] | undefined> = [];
  const implemented: Array<{ scenarioTests?: { scenario: string; file: string }[]; testsFiles?: string[] }> = [];
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
      return { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/w" }, run: { inputCommit: "base0" }, detail: { scenarioReds: reds[Math.min(reviews.length - 1, reds.length - 1)] } };
    },
    judgeRed: async () => ({ verdict: "proceed", problems: [] }),
    checkpoint: async (_c, _where, follows) => void calls.push(`checkpoint:${follows}`),
    holdout: async () => false,
    git: {
      head: async () => headNow(),
      pending: async (_w, base) => (bases.push(base), tree),
      commit: async (_p, subject, body) => {
        calls.push("commit");
        commit = { subject, body };
        return "abc1234";
      },
      reset: async () => void calls.push("discard"),
      readCommit: async () => null,
      branch: async () => "task/x",
    },
    ...over,
  };
  return { deps, calls, reviews, implemented, bases, moveHead: (sha: string) => void (headValue = sha), commit: () => commit };
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
    expect(e.rows.filter(([k]) => k === "scenario.red")).toEqual([["scenario.red", { scenario: "S1" }], ["scenario.red", { scenario: "S2" }]]);
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
  });

  it("sends the writer back with the problems of a scenario whose test two askings say fails for the wrong reason", async () => {
    let n = 0;
    const f = fakes([tagged("S1", "S2")], { judgeRed: async (c) => (c.scenario?.id === "S2" && n++ < 2 ? { verdict: "flag", problems: ["the test fails on an import"] } : { verdict: "proceed", problems: [] }) });
    await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(f.reviews[1]!.join(" ")).toMatch(/S2.*import/);
  });

  it("does not send the writer back for one stray no: the judge is asked again and the majority stands", async () => {
    const asked: string[] = [];
    let n = 0;
    const f = fakes([tagged("S1", "S2")], { judgeRed: async (c) => (asked.push(c.scenario!.id), c.scenario?.id === "S2" && n++ === 0 ? { verdict: "flag", problems: ["the test fails on an import"] } : { verdict: "proceed", problems: [] }) });
    const e = emitted();
    await buildTestsStep(f.deps)({ ...context([v1]), emit: e.emit } as never);
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(asked.filter((id) => id === "S2")).toHaveLength(3);
    expect(asked.filter((id) => id === "S1")).toHaveLength(1);
    expect(e.rows).toContainEqual(["scenario.red_check", expect.objectContaining({ scenario: "S2", verdict: "proceed", asked: 3, flagged: 1 })]);
  });

  it("puts each scenario's verdict on the stream, and on the escalation when the step gives up", async () => {
    const f = fakes([tagged("S1", "S2")], { judgeRed: async (c) => (c.scenario?.id === "S2" ? { verdict: "flag", problems: ["the test fails on an import"] } : { verdict: "proceed", problems: [] }) });
    const e = emitted();
    const result = await buildTestsStep(f.deps)({ ...context([v1]), emit: e.emit } as never);
    expect(e.rows.filter(([k]) => k === "scenario.red_check").map(([, p]) => [p.scenario, p.verdict, p.asked, p.flagged])).toEqual(expect.arrayContaining([["S1", "proceed", 1, 0], ["S2", "flag", 2, 2]]));
    expect(result).toMatchObject({ outcome: "escalated", detail: { testsStep: { status: "failed", redChecks: [{ scenario: "S1", verdict: "proceed" }, { scenario: "S2", verdict: "flag" }] } } });
  });

  it("gives the judge the test's source, read by the machine, beside the writer's report", async () => {
    const seen: Array<string | undefined> = [];
    const f = fakes([tagged("S1")], {
      readTest: async (_w, file, id) => `// ${file} ${id}\nit("x", () => {});`,
      judgeRed: async (c) => (seen.push(c.test), { verdict: "proceed", problems: [] }),
    });
    await buildTestsStep(f.deps)(context([v2]));
    expect(seen).toEqual([expect.stringContaining("it(\"x\"")]);
  });

  it("asks without the source when it cannot be read", async () => {
    const seen: Array<string | undefined> = [];
    const f = fakes([tagged("S1")], { readTest: async () => Promise.reject(new Error("EISDIR")), judgeRed: async (c) => (seen.push(c.test), { verdict: "proceed", problems: [] }) });
    await buildTestsStep(f.deps)(context([v2]));
    expect(seen).toEqual([undefined]);
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

describe("Rust's inline tests", () => {
  const rustTree = (outside = false) => ({
    nameStatus: "M\tboard/src/ui.rs\nA\tboard/tests/extra.rs",
    diff: [
      "diff --git a/board/src/ui.rs b/board/src/ui.rs",
      "--- a/board/src/ui.rs",
      "+++ b/board/src/ui.rs",
      ...(outside ? ["@@ -20,0 +20 @@", "+fn sneaky() {}"] : []),
      "@@ -100,0 +101,5 @@",
      "+#[cfg(test)]",
      "+mod tests {",
      "+    // @scenario:S1",
      "+    // @scenario:S2",
      "+}",
      "diff --git a/board/tests/extra.rs b/board/tests/extra.rs",
      "--- /dev/null",
      "+++ b/board/tests/extra.rs",
      "@@ -0,0 +1 @@",
      "+// helper",
    ].join("\n"),
    testRegions: { "board/src/ui.rs": [[101, 105]] as Array<[number, number]> },
  });

  it("writes the tests in the source file, commits them, and leaves that file to the implementer: it holds production code", async () => {
    const f = fakes([rustTree()]);
    const result = await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(f.implemented[0]!.scenarioTests).toEqual([{ scenario: "S1", file: "board/src/ui.rs" }, { scenario: "S2", file: "board/src/ui.rs" }]);
    // The test file beside it stays protected; the source file with inline tests does not.
    expect(f.implemented[0]!.testsFiles).toEqual(["board/tests/extra.rs"]);
    expect(result.detail).toMatchObject({ testsStep: { status: "committed" } });
  });

  it("sends the writer back when a line outside the test module was added", async () => {
    const f = fakes([rustTree(true), rustTree()]);
    await buildTestsStep(f.deps)(context([v1]));
    expect(f.calls).toEqual(["writer", "writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(f.reviews[1]!.join(" ")).toMatch(/board\/src\/ui\.rs/);
  });
});

describe("a scenario that only runs one of the repo's commands", () => {
  const withCheck = gate({
    plan: { goal: "g", steps: [], acceptance_criteria: [{ id: "C1", text: "c1" }, { id: "C9", text: "board:test and board:lint are clean" }], out_of_scope: [], assumptions: [], rollback: "r", version: 3 },
    cases: [
      { id: "S1", title: "one", criterion: "c1", criterion_ref: "C1", approach: "a" },
      // S13 of the split-card ticket, as its plan wrote it.
      { id: "S13", title: "Both exit 0 with no warnings", criterion: null, criterion_ref: null, given: "The finished change", when: "pnpm board:test and pnpm board:lint run", then: "Both exit 0 with no warnings", approach: "a" },
    ],
  });

  it("needs no test: the step commits S1's and goes on, and says S13 is a check", async () => {
    const asked: string[] = [];
    const f = fakes([tagged("S1")], { repoCommands: async () => ["pnpm board:test"], judgeRed: async (c) => (asked.push(c.scenario!.id), { verdict: "proceed", problems: [] }) }, [{ S1: "FAIL: no part marker" }]);
    const result = await buildTestsStep(f.deps)(context([withCheck]));
    expect(f.calls).toEqual(["writer", "commit", "checkpoint:red", "implement", "sweep"]);
    expect(asked).toEqual(["S1"]);
    expect(result.detail).toMatchObject({ testsStep: { status: "committed", commandChecks: ["S13"] } });
  });

  it("still asks for a test when the repo has no such command", async () => {
    const f = fakes([tagged("S1")], { repoCommands: async () => [] }, [{ S1: "FAIL" }]);
    const result = await buildTestsStep(f.deps)(context([withCheck]));
    expect(result).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringMatching(/S13/) } });
  });
});

describe("scenario.green", () => {
  const emitted = () => {
    const rows: Array<[string, Record<string, unknown>]> = [];
    return { rows, emit: async (kind: string, payload: Record<string, unknown>) => void rows.push([kind, payload]) };
  };

  it("puts a scenario.green row with the id for each scenario's test when the stage passes, and lists the tests with their files on the step", async () => {
    sweeps.length = 0;
    const f = fakes([tagged("S1", "S2")]);
    const e = emitted();
    const result = await buildTestsStep(f.deps)(context([v1], { emit: e.emit }));
    expect(e.rows.filter(([k]) => k === "scenario.green")).toEqual([["scenario.green", { scenario: "S1" }], ["scenario.green", { scenario: "S2" }]]);
    expect(result.detail).toMatchObject({ testsStep: { scenarioTests: [{ scenario: "S1", file: "web/cart.test.ts" }, { scenario: "S2", file: "web/cart.test.ts" }] } });
  });

  it("puts none when the implementer or the sweep did not pass", async () => {
    sweeps.length = 0;
    const f = fakes([tagged("S1")], { implement: async () => ({ outcome: "fail" }) as StageResult });
    const e = emitted();
    await buildTestsStep(f.deps)(context([v2], { emit: e.emit }));
    expect(e.rows.filter(([k]) => k === "scenario.green")).toEqual([]);
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

  it("returns the summed usage when a fix run fails, and puts only the check names on the stage's result", async () => {
    sweeps.length = 0;
    sweeps.push(failing);
    let runs = 0;
    const f = fakes([tagged("S1")], {
      implement: async () => (runs++ === 0 ? ({ outcome: "pass", usage: { turns: 2, costUsd: 1, tokens: { input: 100, output: 10 } } } as StageResult) : ({ outcome: "fail", usage: { turns: 3, costUsd: 2, tokens: { input: 200, output: 20 } } } as StageResult)),
    });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result.outcome).toBe("fail");
    expect(result.usage).toMatchObject({ turns: 5, tokens: { input: 300, output: 30 } });
    sweeps.length = 0;
    sweeps.push(failing, failing, failing, failing);
    const g = fakes([tagged("S1")]);
    const stopped = await buildTestsStep(g.deps)(context([v2]));
    expect(stopped.detail?.sweepFailures).toEqual(["lint"]);
    expect(JSON.stringify(stopped.detail)).not.toContain("no-unused-vars");
  });

  it("reads the budget before each fix run and gives that run the minutes left, and stops when it is spent", async () => {
    sweeps.length = 0;
    sweeps.push(failing, failing, failing);
    const seenMinutes: Array<number | undefined> = [];
    // Read before the writer, before the implementer and before each fix run.
    const states = [{ spent: false, minutesLeft: 50 }, { spent: false, minutesLeft: 40 }, { spent: false, minutesLeft: 25 }, { spent: true, minutesLeft: 0 }];
    const f = fakes([tagged("S1")], {
      implement: async (c) => (seenMinutes.push(c.budgetMinutes), { outcome: "pass" } as StageResult),
      budget: async () => states.shift()!,
    });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(seenMinutes).toEqual([40, 25]);
    expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringMatching(/sweep failed/) } });
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

describe("a sweep that could not run for the environment", () => {
  it("escalates with the sweep's own detail (env_broken, the same step names Verify uses) and does not go round again", async () => {
    sweeps.length = 0;
    const detail = { escalation: "env_broken", envBroken: true, step: "install", tool: "pnpm", lockfile: "pnpm-lock.yaml", reason: "x", logTail: "boom", options: [] };
    sweeps.push({ status: "failed", ran: [], failed: [], escalated: detail });
    const f = fakes([tagged("S1")]);
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result).toMatchObject({ outcome: "escalated", detail: { ...detail, sweep: { status: "failed" } } });
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
      runWriter: async () => ({ outcome: "pass", run: { inputCommit: "base0" }, detail: { scenarioReds: { S1: "FAIL" } }, usage: { turns: 4, costUsd: 0.25, tokens: { input: 100, output: 20 } } }) as StageResult,
      implement: async () => ({ outcome: "pass", usage: { turns: 10, costUsd: 1, tokens: { input: 1000, output: 200 } } }) as StageResult,
    });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result.usage).toEqual({ turns: 14, costUsd: 1.25, tokens: { input: 1100, output: 220, cached: 0 } });
  });

  it("leaves a PR route and a resumed run alone", async () => {
    const f = fakes([tagged("S1")]);
    await buildTestsStep(f.deps)(context([v2], { task: { id: "abcdef12", route: "pr", repoPath: "/r", worktreePath: "/w" } }));
    await buildTestsStep(f.deps)(context([v2], { resume: { container: "c", inputCommit: null } }));
    expect(f.calls).toEqual(["implement", "implement", "sweep"]);
  });

  const recordedCommit = (parent = "base0", tree = tagged("S1")) => ({ ...tree, parent });

  it("does not write the tests twice: a card whose tests commit exists goes straight to the implementer, with the tests listed from that commit, the scope measured from it and every path in it protected", async () => {
    const reads: string[] = [];
    const f = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, readCommit: async (_w, sha) => (reads.push(sha), { ...recordedCommit(), nameStatus: "A\tweb/cart.test.ts\nA\tweb/__fixtures__/cart.json" }) } });
    await buildTestsStep(f.deps)(context([v2], { testsCommit: "def5678", firstInputCommit: "base0" }));
    expect(f.calls).toEqual(["implement", "sweep"]);
    expect(reads).toEqual(["def5678"]);
    expect(f.implemented[0]).toMatchObject({ scenarioTests: [{ scenario: "S1", file: "web/cart.test.ts" }], scopeBase: "def5678", testsFiles: ["web/cart.test.ts", "web/__fixtures__/cart.json"] });
  });

  it("reads the recorded tests commit the same way on a resume", async () => {
    const f = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, readCommit: async () => recordedCommit() } });
    await buildTestsStep(f.deps)(context([v2], { testsCommit: "def5678", firstInputCommit: "base0", resume: { container: "c", inputCommit: null } }));
    expect(f.implemented[0]).toMatchObject({ scopeBase: "def5678", scenarioTests: [{ scenario: "S1", file: "web/cart.test.ts" }] });
  });

  it("escalates head_moved when the recorded tests commit is no longer on the branch: the writer never runs on a HEAD the container moved", async () => {
    const g = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, readCommit: async () => null } });
    const result = await buildTestsStep(g.deps)(context([v2], { testsCommit: "def5678", firstInputCommit: "base0" }));
    expect(g.calls).toEqual([]);
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "head_moved", headMoved: true } });
  });

  it("does not accept a recorded commit whose parent is not the commit the card's first run started from, or whose own diff does not check out", async () => {
    const parent = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, readCommit: async () => recordedCommit("forged") } });
    expect(await buildTestsStep(parent.deps)(context([v2], { testsCommit: "def5678", firstInputCommit: "base0" }))).toMatchObject({ outcome: "escalated", detail: { escalation: "head_moved" } });
    expect(parent.calls).toEqual([]);
    const production = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, readCommit: async () => ({ ...recordedCommit(), nameStatus: "A\tweb/cart.test.ts\nM\tsrc/auth/guard.ts" }) } });
    expect(await buildTestsStep(production.deps)(context([v2], { testsCommit: "def5678", firstInputCommit: "base0" }))).toMatchObject({ outcome: "escalated" });
    expect(production.calls).toEqual([]);
    const unknown = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, readCommit: async () => recordedCommit() } });
    expect(await buildTestsStep(unknown.deps)(context([v2], { testsCommit: "def5678" }))).toMatchObject({ outcome: "escalated" });
  });

  it("checks the worktree is on the writer's branch before it commits, and escalates when the container switched it", async () => {
    const f = fakes([tagged("S1")], { git: { ...fakes([tagged("S1")]).deps.git, branch: async () => "main" } });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).not.toContain("commit");
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "head_moved" } });
  });

  it("passes every path of the tests it committed on, so each is protected, with the scope measured from the commit it made", async () => {
    const two = { nameStatus: "A\tweb/cart.test.ts\nA\tweb/helper.test.ts", diff: tagged("S1").diff };
    const f = fakes([two]);
    await buildTestsStep(f.deps)(context([v2]));
    expect(f.implemented[0]).toMatchObject({ scopeBase: "abc1234", testsFiles: ["web/cart.test.ts", "web/helper.test.ts"] });
  });

  it("reads the writer's changes against the base it started from, and refuses a HEAD the container moved: the tree goes back to the base and the writer is sent back once, then a person", async () => {
    const f = fakes([tagged("S1")]);
    f.moveHead("forged1");
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(f.calls).toEqual(["writer", "discard", "writer", "discard"]);
    expect(f.reviews[1]!.join(" ")).toMatch(/commit/);
    expect(result).toMatchObject({ outcome: "escalated" });
    const ok = fakes([tagged("S1")]);
    await buildTestsStep(ok.deps)(context([v2]));
    expect(ok.bases).toEqual(["base0"]);
  });

  it("fails closed when the run does not say what it started from", async () => {
    const f = fakes([tagged("S1")], { runWriter: async () => ({ outcome: "pass", detail: { scenarioReds: { S1: "x" } } }) as StageResult });
    expect(await buildTestsStep(f.deps)(context([v2]))).toMatchObject({ outcome: "fail" });
    expect(f.calls).toEqual([]);
  });

  it("sends back a test line that carries several scenario ids", async () => {
    const one = { nameStatus: "A\tweb/cart.test.ts", diff: ["diff --git a/web/cart.test.ts b/web/cart.test.ts", "--- /dev/null", "+++ b/web/cart.test.ts", "@@ -0,0 +1 @@", '+it("x @scenario:S1 @scenario:S2", () => {})'].join("\n") };
    const f = fakes([one]);
    const result = await buildTestsStep(f.deps)(context([v1]));
    expect(f.reviews[1]!.join(" ")).toMatch(/several/);
    expect(result).toMatchObject({ outcome: "escalated" });
  });

  it("passes a writer's failure or usage limit straight up", async () => {
    const f = fakes([tagged("S1")], { runWriter: async () => ({ outcome: "fail", rateLimited: true }) as StageResult });
    const result = await buildTestsStep(f.deps)(context([v2]));
    expect(result).toMatchObject({ rateLimited: true });
    expect(f.calls).toEqual([]);
  });
});

describe("Build's budget across the tests step", () => {
  it("hands each writer round and the implementer the minutes that remain of one shared deadline, and stops when none remain", async () => {
    let clock = 0;
    const minutes: Array<number | undefined> = [];
    const f = fakes([tagged("S1")], {
      now: () => clock,
      runWriter: async (c) => {
        minutes.push(c.budgetMinutes);
        clock += 3 * 60_000;
        return { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/w" }, run: { inputCommit: "base0" }, detail: { scenarioReds: {} } };
      },
    });
    const result = await buildTestsStep(f.deps)(context([v2], { budgetMinutes: 5 }));
    // The first round gets 5, the second 2, and the third finds the deadline passed: nothing more runs.
    expect(minutes).toEqual([5, 2]);
    expect(result).toMatchObject({ outcome: "escalated", detail: { budgetSpent: true } });
    expect(f.calls).not.toContain("implement");
  });

  it("clamps the implementer to the minutes the writer left, and reads the store's budget before each run", async () => {
    let clock = 0;
    const implementerMinutes: Array<number | undefined> = [];
    const f = fakes([tagged("S1")], {
      now: () => clock,
      budget: async () => ({ spent: false, minutesLeft: 40 }),
      runWriter: async () => {
        clock += 4 * 60_000;
        return { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/w" }, run: { inputCommit: "base0" }, detail: { scenarioReds: { S1: "FAIL" } } };
      },
      implement: async (c) => (implementerMinutes.push(c.budgetMinutes), { outcome: "pass" } as StageResult),
    });
    await buildTestsStep(f.deps)(context([v2], { budgetMinutes: 10 }));
    expect(implementerMinutes).toEqual([6]);
  });

  it("escalates instead of running the implementer when the store says the budget is spent", async () => {
    const f = fakes([tagged("S1")], { budget: async () => ({ spent: true, minutesLeft: 0 }) });
    const result = await buildTestsStep(f.deps)(context([v2], { budgetMinutes: 10 }));
    expect(result).toMatchObject({ outcome: "escalated", detail: { budgetSpent: true } });
    expect(f.calls).toEqual([]);
  });
});
