import { LOOP_STUCK, factoryConfigOf } from "@hardness/contracts";
import { type Economy, noEconomy } from "./economy.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_ON, previewOn } from "../test/policies.ts";

import { type EngineId, type TaskState, TriageRecord } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DecisionTruth, tagged } from "./decision-truth.ts";
import { NO_RETRIES, TransitionError } from "../domain/transition.ts";
import type { StageContext, StageResult, StageRunner } from "./ports.ts";
import { loadConfig } from "../config.ts";
import { StubStages } from "./stages/stubs.ts";
import { currentTask } from "./task-scope.ts";
import { withTriageSignals } from "./stages/triage-signals.ts";
import { PgTaskStore } from "../adapters/persistence/task-store.ts";
import { freshTestDatabase } from "../test/database.ts";
import { ApprovalEntity } from "../adapters/persistence/schemas.ts";
import { ApproverRequiredError, type BudgetAlert, NoQuestionsToPostError, NotReleaseOwnerError, OutsideApproverRequiredError, Pipeline, PlanApprovedError, testPathsIn, RejectNotAllowedError, QuestionsCarrySecretError, RecordNotEditableError, SameApproverError, SourceImmutableError, TaskMovedError, TaskNotFoundError, WorktreeUnpushedError } from "./pipeline.ts";
import { DEFAULT_POLICY } from "../domain/policy.ts";
import { approvedPlan, buildStageInput } from "../domain/stage-input.ts";
import { ensureClone } from "../adapters/git/clone.ts";
import { commitAll, ensureWorktree, workspaceFor } from "../adapters/git/worktree.ts";
import type { CloseReport } from "./close-task.ts";
import { toStageRun } from "../adapters/http/serialize.ts";
import { type RunEnd, type RunStart, type Telemetry, noTelemetry } from "./telemetry.ts";

/** A telemetry that keeps what it was told. */
function recordingTelemetry() {
  const spans: Array<{ start: RunStart; events: Array<{ name: string; payload: Record<string, unknown> | undefined }>; end: RunEnd | null }> = [];
  const telemetry: Telemetry = {
    ...noTelemetry(),
    mode: "metadata",
    run: (start) => {
      const span = { start, events: [] as Array<{ name: string; payload: Record<string, unknown> | undefined }>, end: null as RunEnd | null };
      spans.push(span);
      return {
        event: (name, payload) => void span.events.push({ name, payload }),
        traceId: () => `trace-${spans.length}`,
        childEnv: () => ({ LMNR_SPAN_CONTEXT: `ctx-${spans.length}` }),
        end: async (end) => void (span.end = end),
      };
    },
  };
  return { telemetry, spans };
}

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

const fail: StageResult = { outcome: "fail" };

/** A stage that holds its slot until the task is aborted, the way a real container does. The
 *  abort can land before the runner is called (the loop is still recording the run, slow on a
 *  CI runner): an already-aborted signal ends it at once, as the docker and exec adapters do,
 *  or the loop never ends and abort()/shutdown() wait out their deadlines. */
const holding: StageRunner = ({ signal }) =>
  new Promise<StageResult>((resolve) => {
    if (signal.aborted) resolve({ outcome: "fail" });
    else signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true });
  });

beforeAll(async () => {
  db = await freshTestDatabase();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  // The last test's loops may still be writing events (a queued task claimed as the test ended);
  // truncating under them deadlocks. Wind them down first.
  await pipeline?.shutdown();
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});

/** A ticket in Intake (draft), ready for `pipeline.start()` to run triage. */
const newTask = () => pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });

/** Starts a task and approves the one plan gate (after triage and the plan stage), which reaches the implementer. */
async function startAndApprove(id: string) {
  await pipeline.start(id);
  return pipeline.decide(id, "approved");
}

const stagesRun = async (id: string): Promise<TaskState[]> =>
  (await pipeline.stageRuns(id)).map((run) => run.stage);

describe("creating and starting", () => {
  it("creates a task in Intake with an empty retry budget", async () => {
    const task = await pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    expect(task).toMatchObject({ state: "draft", retries: NO_RETRIES, resumeTo: null });
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toEqual(["task.created"]);
  });

  it("records a repository image's events as rows on the card", async () => {
    const task = await pipeline.createTask({ title: "Image", criteria: ["x"] });
    await pipeline.recordImageEvent(task.id, { kind: "image.build_failed", taskId: task.id, repoPath: "/r", base: "debian:12", reason: "step 3 failed" });
    const rows = await pipeline.events(task.id);
    expect(rows.at(-1)).toMatchObject({ kind: "image.build_failed", payload: { base: "debian:12", reason: "step 3 failed" } });
    expect(rows.at(-1)!.payload).not.toHaveProperty("taskId");
  });

  it("keeps the tracker source and starts with no artifacts", async () => {
    const source = { kind: "github", repo: "owner/name", number: 42, url: "https://github.com/owner/name/issues/42" } as const;
    const task = await pipeline.createTask({ title: "Login page", source });
    expect(task.source).toEqual(source);
    expect(await pipeline.artifacts(task.id)).toEqual([]);

    await expect(pipeline.update(task.id, { source: null })).rejects.toThrow(SourceImmutableError);
    expect((await pipeline.update(task.id, { source: { ...source } })).source).toEqual(source);
  });

  it("keeps the source's labels, and a client sending the source back with or without them is no change", async () => {
    const source = { kind: "github", repo: "owner/name", number: 43, url: "https://github.com/owner/name/issues/43" } as const;
    const task = await pipeline.createTask({ title: "Login page", source: { ...source, labels: ["security"] } });
    expect((await pipeline.update(task.id, { source })).source).toMatchObject({ labels: ["security"] });
  });

  it("runs triage and the plan stage on start and waits for you to approve the plan", async () => {
    const task = await newTask();
    const started = await pipeline.start(task.id);

    expect(started.state).toBe("awaiting_approval");
    expect(await pipeline.stageRuns(task.id)).toMatchObject([
      { stage: "triage", attempt: 1, status: "passed", outcome: "pass" },
      { stage: "test_design", attempt: 1, status: "passed", outcome: "pass" },
    ]);
    expect(await pipeline.approvals(task.id)).toMatchObject([
      { kind: "awaiting_approval", decision: null },
    ]);
  });
});

describe("triage's record", () => {
  it("keeps the TriageRecord the triage runner assembled, on the task", async () => {
    const record = { goal: "Stop the panic", reason: "one function" };
    const classification = { kind: "bug", ready: true, size: 1, sizeBucket: "S" as const, typeOfWork: "backend" as const, priority: "P1" as const, riskPrelim: "low" as const, subScores: { who: 2, what: 2, impact: 2, time: 1, demand: 1 }, confidence: 0.9, at: "2026-11-05T00:00:00.000Z", model: "m" };
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "plan", summary: "A panic on j.", record, criteria: ["c1"] } });
    const saving = (stage: TaskState) =>
      stage === "triage" ? withTriageSignals(stubs.runnerFor(stage), { classify: null, save: (id, patch) => new PgTaskStore(db).updateTask(id, patch) }) : stubs.runnerFor(stage);
    const p = new Pipeline(db, saving, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login page", classification });
    await p.start(task.id);
    expect(TriageRecord.parse((await p.get(task.id)).record)).toMatchObject({ ...record, summary: "A panic on j.", kind: "bug", typeOfWork: "backend", size: "S", riskPrelim: "low", source: "manual", decision: "fast_lane", signals: {}, qa: [], decisionBy: "machine", version: 1, goalRef: "none" });
  });
});

describe("the plan gate", () => {
  const slices = [{ title: "guard j", est_loc: 12, touchpoints: ["board/src/keys.rs"], acceptance: ["no panic"] }];
  const cases = [{ title: "j on empty", criterion: "no panic", approach: "cargo test keys::empty" }];
  const planned: StageResult = {
    outcome: "pass",
    detail: {
      brief: "Guard the empty list", criteria: ["no panic"], assumptions: ["board only"], slices, rollback: "revert the commit", cases,
      risk: { level: "low", scores: { blast_radius: 0, reversibility: 0, data_sensitivity: 0 } },
      verdicts: { coverage: "proceed", plan: "proceed", risk: "proceed" }, rounds: { tests: 1, plan: 1 }, flagged: [],
    },
  };

  it("shows the plan, the scenarios, the risk and the verdicts at one gate; approving it builds with the slices and the scenarios", async () => {
    stubs.plan("test_design", planned);
    const seen: Array<{ plan: unknown; testCases: unknown }> = [];
    const runner = (stage: TaskState): StageRunner =>
      stage === "implementing"
        ? async (context) => {
            const input = buildStageInput({ task: context.task, stage: "implementing", attempt: 1, approvals: context.approvals, priorFindings: [] });
            seen.push({ plan: input.plan, testCases: input.context.testCases });
            return { outcome: "fail" };
          }
        : stubs.runnerFor(stage);
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    expect((await pipeline.start(task.id)).state).toBe("awaiting_approval");
    expect(await stagesRun(task.id)).toEqual(["triage", "test_design"]);
    const [gate] = await pipeline.approvals(task.id);
    expect(gate).toMatchObject({ kind: "awaiting_approval", decision: null, requested: planned.detail });
    expect(gate!.requested).not.toHaveProperty("outcome");

    await pipeline.decide(task.id, "approved");
    expect(seen[0]).toMatchObject({ plan: { brief: "Guard the empty list", slices, rollback: "revert the commit" }, testCases: cases });
  });

  it("replaces the scenarios on the gate, which is what implementing then reads", async () => {
    stubs.plan("test_design", planned);
    const task = await newTask();
    await pipeline.start(task.id);
    const edited = [{ title: "edited", criterion: "no panic", approach: "run it" }];
    await pipeline.editCases(task.id, edited);
    const [gate] = await pipeline.approvals(task.id);
    expect(gate!.requested).toMatchObject({ brief: "Guard the empty list", cases: edited });
    await pipeline.decide(task.id, "approved");
    expect(approvedPlan(await pipeline.approvals(task.id))).toMatchObject({ rollback: "revert the commit" });
    expect(buildStageInput({ task: await pipeline.get(task.id), stage: "implementing", attempt: 1, approvals: await pipeline.approvals(task.id), priorFindings: [] }).context.testCases).toEqual(edited);
  });

  it("refuses to edit scenarios at a gate that has none: a triage outcome", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "duplicate" } });
    const task = await newTask();
    await pipeline.start(task.id);
    await expect(pipeline.editCases(task.id, cases)).rejects.toThrow(/no test cases/i);
  });
});

describe("a plan found wrong comes back to the planner with its evidence", () => {
  const seen: Array<NonNullable<StageContext["replan"]> | undefined> = [];
  const capturing = (stage: TaskState): StageRunner => {
    const inner = stubs.runnerFor(stage);
    return (context) => {
      if (stage === "test_design") seen.push(context.replan);
      return inner(context);
    };
  };
  const wrong = (from: "implementing" | "verifying") => ({ outcome: "escalated" as const, detail: { escalation: "plan_wrong", reason: "the plan names a module that does not exist", error: `tsc: cannot find module x\n${"noise ".repeat(600)}last line`, findings: [{ title: "x is missing", path: "a.ts", line: 3 }], from } });

  it.each(["implementing", "verifying"] as const)("from %s: the plan stage runs again, the record is untouched, and the planner is told who raised it, why and the output's tail", async (from) => {
    seen.length = 0;
    const p = new Pipeline(db, capturing, { inline: true, policies: previewOn, hasConfig: () => true });
    stubs.plan(from, wrong(from));
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    const recordBefore = (await p.get(task.id)).record;
    await p.decide(task.id, "approved");
    expect(seen[0]).toBeUndefined();
    expect(seen.length).toBe(2);
    expect(seen[1]).toMatchObject({ raised_by: from, reason: "the plan names a module that does not exist", findings: ["a.ts:3 x is missing"], output: expect.stringMatching(/last line$/) });
    expect(seen[1]!.output!.length).toBeLessThanOrEqual(2000);
    expect((await p.get(task.id)).record).toEqual(recordBefore);
    expect((await p.events(task.id)).some((e) => e.kind === "transition" && e.payload.to === "triage" && e.payload.from !== "draft")).toBe(false);
  });

  it("a second plan_wrong on the same card escalates to a person", async () => {
    seen.length = 0;
    const p = new Pipeline(db, capturing, { inline: true, policies: previewOn, hasConfig: () => true });
    stubs.plan("implementing", wrong("implementing"), wrong("implementing"));
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect((await p.get(task.id)).state).toBe("awaiting_approval");
    await p.decide(task.id, "approved");
    expect((await p.get(task.id)).state).toBe("escalated");
  });

  const thin = {
    outcome: "pass" as const,
    detail: {
      brief: "b",
      criteria: ["c1"],
      assumptions: [],
      slices: [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }],
      cases: [],
      plan: { goal: "g", steps: [{ id: "P1", title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"], files: ["a.ts"] }], acceptance_criteria: [{ id: "C1", text: "c1" }], out_of_scope: [], assumptions: [], rollback: "revert", version: 2 },
      risk: { level: "low", scores: {} },
    },
  };

  it("the entry contract: a v2.2 gate missing a scenario and a map goes back to the planner with the list, once, and a row on the stream", async () => {
    seen.length = 0;
    const p = new Pipeline(db, capturing, { inline: true, policies: previewOn, hasConfig: () => true });
    stubs.plan("test_design", thin, thin);
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await new PgTaskStore(db).updateTask(task.id, { record: { goal: "g" } as never });
    await p.decide(task.id, "approved");
    expect(seen.length).toBe(2);
    expect(seen[1]).toMatchObject({ raised_by: "entry_contract", reason: expect.stringMatching(/scenario for criterion C1.*code map/) });
    expect((await p.events(task.id)).filter((e) => e.kind === "build.entry_contract")).toHaveLength(1);
    expect((await p.get(task.id)).state).toBe("awaiting_approval");
    await p.decide(task.id, "approved");
    expect((await p.get(task.id)).state).toBe("escalated");
  });

  it("the entry contract: a gate approved before v2.2 (brief, slices, a case, no plan object) still builds", async () => {
    const ran: TaskState[] = [];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => (ran.push(stage), { outcome: "fail" as const }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran).toContain("implementing");
  });

  it("a plan stage that runs for any other reason carries no replan", async () => {
    seen.length = 0;
    const p = new Pipeline(db, capturing, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "sent_back", "again");
    expect(seen.every((r) => r === undefined)).toBe(true);
  });
});

describe("why Build escalated is a typed decision", () => {
  const choice = (label: string, confidence: number) => ({ reason: { choice: label, confidence } });
  const agentStop = (word: string) => ({ outcome: "escalated" as const, detail: { escalation: word, reason: "I cannot go on", summary: "stopped at slice 2", error: "Error: boom at a.ts:3" } });
  const build = (decide: ((pack: string, check: unknown) => Promise<Record<string, unknown>>) | null, implementing: StageRunner) =>
    new Pipeline(db, (stage) => (stage === "implementing" ? implementing : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true, escalationDecide: { decide: decide as never } });
  const approvedCard = async (p: Pipeline) => {
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    return task.id;
  };
  const lastMove = async (p: Pipeline, id: string) => (await p.events(id)).findLast((e) => e.kind === "transition" && e.payload.to === "escalated")?.payload;

  it("takes the decision's reason over the agent's word, routes by it, and keeps the agent's word beside it on the gate with the confidence, the summary and the output's tail", async () => {
    const asked: unknown[] = [];
    const p = build(async (pack, check) => (asked.push([pack, check]), choice("env_broken", 0.9)), async () => agentStop("plan_wrong"));
    const id = await approvedCard(p);
    expect(asked).toHaveLength(1);
    expect(await lastMove(p, id)).toMatchObject({ escalation: "env_broken" });
    const gate = (await p.approvals(id)).find((a) => a.kind === "escalated")!;
    expect(gate.requested).toMatchObject({ escalationDecision: { reason: "env_broken", confidence: 0.9, source: "decision", agentReason: "plan_wrong" }, summary: "stopped at slice 2", outputTail: expect.stringContaining("boom at a.ts:3") });
  });

  it("sends a decided plan_wrong back to the planner, once", async () => {
    const seen: string[] = [];
    const p = build(async () => choice("plan_wrong", 0.95), async () => (seen.push("run"), agentStop("other")));
    await approvedCard(p);
    expect(seen.length).toBe(1);
    expect((await p.events((await p.list())[0]!.id)).some((e) => e.kind === "transition" && e.payload.to === "test_design" && e.payload.escalation === "plan_wrong")).toBe(true);
  });

  it("is `other` for a person under the bar, and leaves the agent's word when no decision can run", async () => {
    const low = build(async () => choice("plan_wrong", 0.3), async () => agentStop("flaky_tests"));
    expect(await lastMove(low, await approvedCard(low))).toMatchObject({ escalation: "other" });
    const none = build(null, async () => agentStop("flaky_tests"));
    expect(await lastMove(none, await approvedCard(none))).toMatchObject({ escalation: "flaky_tests" });
  });

  it("gives a spent budget to the decision, not to too_complex by default: flaky tests end at a person with no more runs", async () => {
    const ran: number[] = [];
    const events = Array.from({ length: 16 }, (_, i) => ({ at: new Date(i).toISOString(), kind: i % 2 ? "slice.green" : "slice.red", payload: { id: 1 } }));
    const p = build(async () => choice("flaky_tests", 0.9), async () => (ran.push(1), { outcome: "fail" as const, events, detail: { error: "FAIL a.test.ts" } }));
    const id = await approvedCard(p);
    expect(ran).toHaveLength(1);
    expect(await lastMove(p, id)).toMatchObject({ escalation: "flaky_tests" });
  });

  it("gives a decided too_complex the stronger model once with one fresh full budget counted from its own start, then a person, and never twice", async () => {
    const ran: number[] = [];
    const events = Array.from({ length: 16 }, (_, i) => ({ at: new Date(i).toISOString(), kind: i % 2 ? "slice.green" : "slice.red", payload: { id: 1 } }));
    const p = build(async () => choice("too_complex", 0.9), async () => (ran.push(1), { outcome: "fail" as const, events }));
    const id = await approvedCard(p);
    expect(ran).toHaveLength(2);
    expect((await p.events(id)).filter((e) => e.kind === "build.budget_reset")).toHaveLength(1);
    expect(await lastMove(p, id)).toMatchObject({ escalation: "too_complex" });
    expect((await p.get(id)).state).toBe("escalated");
  });

  it("gives an escalation the machine made, the run cap, a reason too", async () => {
    const p = build(null, async () => ({ outcome: "fail" as const, detail: { error: `a different failure ${Math.random()}` } }));
    const id = await approvedCard(p);
    expect((await p.get(id)).state).toBe("escalated");
    expect(await lastMove(p, id)).toMatchObject({ escalation: "other", reason: expect.stringMatching(/implementer used all|failed/) });
  });

  it("decides a service or container that never started by fact: env_broken, no model asked", async () => {
    const asked: unknown[] = [];
    const p = build(async (...a) => (asked.push(a), choice("flaky_tests", 0.9)), async () => ({ outcome: "fail" as const, detail: { error: "service db not ready", envBroken: true } }));
    const id = await approvedCard(p);
    expect(asked).toEqual([]);
    expect(await lastMove(p, id)).toMatchObject({ escalation: "env_broken" });
  });
});

describe("what a person does after an escalation", () => {
  const stop = { outcome: "escalated" as const, detail: { escalation: "other", reason: "stuck", summary: "stopped", error: "boom" } };
  const learned: Array<Record<string, unknown>> = [];
  const written: Array<{ corrected: string | null; commits: unknown }> = [];
  const sinces: string[] = [];
  const make = (decide: unknown = async () => tagged({ answer: { reason: { choice: "flaky_tests", confidence: 0.9 } }, recordId: "rec-9" })) =>
    new Pipeline(db, (stage) => (stage === "implementing" ? async () => stop : stubs.runnerFor(stage)), {
      policies: previewOn,
      inline: true,
      hasConfig: () => true,
      escalationDecide: { decide: decide as never },
      truth: { learned: async (fact: Record<string, unknown>) => (learned.push(fact), true) } as never,
      escalationTruth: async (_task, _approval, commits, corrected) => (written.push({ corrected, commits }), "/gt/escalation.json"),
      headOf: async () => "d".repeat(40),
      commitsSince: async (_worktree, since) => (sinces.push(since), [{ sha: "a".repeat(40), files: [{ path: "src/a.ts", added: 2, removed: 1 }] }]),
    });
  const escalatedCard = async (p: Pipeline) => {
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    return task.id;
  };

  it("labels the decision record with the reason a person corrects it to, and does not move a card that already waits for a person", async () => {
    learned.length = 0;
    const p = make();
    const id = await escalatedCard(p);
    expect((await p.get(id)).state).toBe("escalated");
    const gate = (await p.approvals(id)).find((a) => a.kind === "escalated")!;
    expect(gate.requested).toMatchObject({ escalationDecision: { reason: "flaky_tests", recordId: "rec-9" } });
    const after = await p.correctEscalationReason(id, "env_broken");
    expect(after.state).toBe("escalated");
    expect(learned).toEqual([expect.objectContaining({ pack: "escalation_reason", recordId: "rec-9", label: { reason: { choice: "env_broken" } }, source: "escalation_correction", taskId: id })]);
    expect((await p.events(id)).filter((e) => e.kind === "escalation.corrected")).toEqual([expect.objectContaining({ payload: expect.objectContaining({ from: "flaky_tests", to: "env_broken" }) })]);
  });

  it("a card resumed with no correction confirms the reason the machine gave, as an outcome; a correction first leaves the person's word alone", async () => {
    learned.length = 0;
    const plain = make();
    const id = await escalatedCard(plain);
    await plain.decide(id, "approved");
    expect(learned).toEqual([expect.objectContaining({ pack: "escalation_reason", recordId: "rec-9", label: { reason: { choice: "flaky_tests" } }, source: "escalation_resumed", kind: "outcome", taskId: id })]);
    learned.length = 0;
    const corrected = make();
    const other = await escalatedCard(corrected);
    await corrected.correctEscalationReason(other, "env_broken");
    learned.length = 0;
    await corrected.decide(other, "approved");
    expect(learned).toEqual([]);
  });

  it("takes the enum only, and only at an escalated gate", async () => {
    const p = make();
    const id = await escalatedCard(p);
    await expect(p.correctEscalationReason(id, "head_moved")).rejects.toThrow(/reason/);
    await expect(p.correctEscalationReason(id, "because I said so")).rejects.toThrow(/reason/);
    const other = await p.createTask({ title: "Other" });
    await expect(p.correctEscalationReason(other.id, "env_broken")).rejects.toThrow(/escalat/i);
  });

  it("records, when a person resumes the card, the commits made since the escalation as ground truth (names and counts) beside the decision, with the corrected reason", async () => {
    written.length = 0;
    const p = make();
    const id = await escalatedCard(p);
    await new PgTaskStore(db).updateTask(id, { worktreePath: "/work/t" });
    await p.correctEscalationReason(id, "env_broken");
    await p.decide(id, "approved", "fixed it");
    // The escalated gate stored HEAD's sha when it opened; the record reads the commits after that sha, never after a date.
    expect(sinces).toEqual(["d".repeat(40)]);
    expect((await p.approvals(id)).find((a) => a.kind === "escalated")!.requested.headSha).toBe("d".repeat(40));
    expect(written).toEqual([{ corrected: "env_broken", commits: [{ sha: "a".repeat(40), files: [{ path: "src/a.ts", added: 2, removed: 1 }] }] }]);
    expect((await p.events(id)).some((e) => e.kind === "ground_truth.written" && e.payload.path === "/gt/escalation.json")).toBe(true);
  });
});

describe("the tests commit a later run of the card may trust", () => {
  it("hands a run the sha the machine itself recorded on an earlier finish row, and nothing for a sha that is not a sha", async () => {
    const seen: Array<string | undefined> = [];
    const results = [
      { outcome: "fail" as const, detail: { testsStep: { status: "committed", commit: "abc1234def" } } },
      { outcome: "fail" as const, detail: { testsStep: { status: "committed", commit: "not a sha; rm -rf" } } },
      { outcome: "fail" as const },
    ];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async (context) => (seen.push(context.testsCommit), results[Math.min(seen.length - 1, results.length - 1)]!) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("abc1234def");
    // The newest finish row with a sha wins; a malformed one is ignored.
    expect(seen[2]).toBe("abc1234def");
  });
});

describe("the commit the card's first implementing run started from", () => {
  it("is read from the machine's own stage run rows and handed to every later run, whatever a later run started from", async () => {
    const seen: Array<string | undefined> = [];
    const started = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async (context) => (seen.push(context.firstInputCommit), await context.started?.({ container: "c", inputCommit: started[seen.length - 1]! }), { outcome: "fail" as const, detail: { error: `different ${seen.length}` } }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("a".repeat(40));
    expect(seen[2]).toBe("a".repeat(40));
  });
});

describe("the base commit of a run that starts several containers", () => {
  it("stays the first container's commit when the implementer then starts on the tests commit, for every later run", async () => {
    const seen: Array<string | undefined> = [];
    const base = "a".repeat(40);
    const testsCommit = "b".repeat(40);
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async (context) => (seen.push(context.firstInputCommit), await context.started?.({ container: "w", inputCommit: base }), await context.started?.({ container: "i", inputCommit: testsCommit }), { outcome: "fail" as const, detail: { error: `different ${seen.length}` } }) : stubs.runnerFor(stage)), { inline: true, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe(base);
    expect(seen[2]).toBe(base);
  });
});

describe("a scope problem gets one fix pass, then a person", () => {
  const red = { outcome: "fail" as const, detail: { scopeRed: true, error: "scope check failed" }, findings: [{ path: "x.ts", line: 0, start_line: null, severity: "scope", title: "file outside the plan, not declared", body: "revert it", suggestion_code: null, confidence: 1 }] };

  it("runs the implementer once more after the first scope red, with the issues as findings, and escalates the second with the reason undeclared_scope", async () => {
    const ran: Array<number> = [];
    const seenFindings: unknown[] = [];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async (context) => (ran.push(1), seenFindings.push(context.priorFindings), red) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran).toHaveLength(2);
    expect(seenFindings[1]).toEqual([expect.objectContaining({ severity: "scope" })]);
    expect((await p.get(task.id)).state).toBe("escalated");
    const moved = (await p.events(task.id)).findLast((e) => e.kind === "transition" && e.payload.to === "escalated");
    expect(moved?.payload).toMatchObject({ escalation: "undeclared_scope" });
  });

  it("does not count a red that is not a scope red (a failing run of any other kind) against the one fix pass", async () => {
    const ran: Array<number> = [];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => (ran.push(1), ran.length === 1 ? red : { outcome: "fail" as const }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran.length).toBeGreaterThan(2);
  });
});

describe("Build's budget", () => {
  const events = (n: number) => Array.from({ length: n }, (_, i) => ({ at: new Date(i).toISOString(), kind: i % 2 ? "slice.green" : "slice.red", payload: { id: 1 } }));

  it("escalates a card whose iterations are spent instead of running the implementer again, with the numbers", async () => {
    const ran: string[] = [];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => (ran.push(stage), { outcome: "fail" as const, events: events(16) }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran).toHaveLength(1);
    const after = await p.get(task.id);
    expect(after.state).toBe("escalated");
    const gate = (await p.events(task.id)).findLast((e) => e.kind === "transition" && e.payload.to === "escalated");
    expect(gate?.payload.reason).toMatch(/budget is spent: 16 of 15 iterations/);
    expect(gate?.payload.reason).toMatch(/tokens not counted/);
    expect((await p.events(task.id)).some((e) => e.kind === "build.budget")).toBe(true);
  });

  it("runs Build again with a fresh budget when a person approves the spent-budget escalation, once per approval", async () => {
    const ran: string[] = [];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => (ran.push(stage), { outcome: "fail" as const, events: events(16) }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran).toHaveLength(1);
    expect((await p.get(task.id)).state).toBe("escalated");
    // Approving the spent budget runs the implementer again, which it never did before (the same spent budget escalated at once).
    await p.decide(task.id, "approved");
    expect(ran).toHaveLength(2);
    expect((await p.events(task.id)).filter((e) => e.kind === "build.budget_reset")).toHaveLength(1);
  });

  it("counts the runtime's tokens from the finish row, and a run that reports none leaves them uncounted", async () => {
    const ran: string[] = [];
    const usage = { turns: 1, costUsd: null, tokens: { input: 1_900_000, output: 100_001 } };
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => (ran.push(stage), { outcome: "fail" as const, usage }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran).toHaveLength(1);
    const gate = (await p.events(task.id)).findLast((e) => e.kind === "transition" && e.payload.to === "escalated");
    expect(gate?.payload.reason).toMatch(/budget is spent: 2000001 of 2000000 tokens/);
    expect((await p.events(task.id)).find((e) => e.kind === "stage.finished" && e.payload.stage === "implementing")?.payload.tokens).toEqual({ input: 1_900_000, output: 100_001 });
  });

  it("puts the tokens, the iteration log and the limits on the Build Report of a card that passed", async () => {
    const usage = { turns: 1, costUsd: null, tokens: { input: 1000, output: 250 } };
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => ({ outcome: "pass" as const, usage, events: events(2) }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    const report = (await p.reports(task.id)).build;
    expect(report).toMatchObject({ tokens: 1250, iterations: [{ kind: "red" }, { kind: "green" }], limits: { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90 } });
  });

  it("lets a card inside its budget run again as before", async () => {
    const ran: string[] = [];
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => (ran.push(stage), { outcome: "fail" as const, events: events(2) }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(ran.length).toBeGreaterThan(1);
  });
});

describe("the plan gate's three decisions", () => {
  const atGate = async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], risk: { level: "low", scores: {} } } });
    const task = await newTask();
    await pipeline.start(task.id);
    return task.id;
  };

  it("takes changes_requested as today's sent_back: the card goes back, the comment is its reason, the row says sent_back", async () => {
    const id = await atGate();
    await pipeline.decide(id, "changes_requested", "split the migration");
    // The card went back to triage and came round to a new plan gate.
    expect((await pipeline.approvals(id)).length).toBe(2);
    expect((await pipeline.approvals(id))[0]).toMatchObject({ decision: "sent_back", reason: "split the migration" });
    expect((await pipeline.events(id)).find((e) => e.kind === "transition" && e.payload.event === "sent_back")).toBeDefined();
  });

  it("still takes sent_back", async () => {
    const id = await atGate();
    await pipeline.decide(id, "sent_back", "no");
    expect((await pipeline.approvals(id))[0]).toMatchObject({ decision: "sent_back", reason: "no" });
  });

  it("rejects: the card is archived with reason rejected, and the comment is kept", async () => {
    const id = await atGate();
    const done = await pipeline.decide(id, "rejected", "we will not build this");
    expect(done).toMatchObject({ state: "archived", archiveReason: "rejected" });
    expect((await pipeline.approvals(id))[0]).toMatchObject({ decision: "rejected", reason: "we will not build this" });
    expect((await pipeline.events(id)).find((e) => e.kind === "transition" && e.payload.archiveReason === "rejected")).toBeDefined();
  });

  it("refuses to reject anywhere but the plan gate", async () => {
    stubs.plan("triage", { outcome: "needs_input", detail: { questions: [{ question: "q", recommended: "r" }] } });
    const asking = await newTask();
    await pipeline.start(asking.id);
    await expect(pipeline.decide(asking.id, "rejected")).rejects.toBeInstanceOf(RejectNotAllowedError);
    expect((await pipeline.get(asking.id)).state).toBe("awaiting_answers");
    stubs.reset();
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "duplicate" } });
    const triaged = await newTask();
    await pipeline.start(triaged.id);
    await expect(pipeline.decide(triaged.id, "rejected")).rejects.toBeInstanceOf(RejectNotAllowedError);
  });
});

describe("approvers", () => {
  const atGate = async (level: "low" | "high") => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", risk: { level, scores: {} } } });
    const task = await newTask();
    await pipeline.start(task.id);
    return task.id;
  };

  it("keeps the approver's name on any approval, and approves a plan that is not High risk at once", async () => {
    const id = await atGate("low");
    expect((await pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" })).state).toBe("awaiting_ship");
    expect((await pipeline.approvals(id))[0]).toMatchObject({ decision: "approved", response: { approver: "ana" } });
  });

  it("holds a High-risk plan for a second, distinct name; the first is on the gate as 1 of 2", async () => {
    const id = await atGate("high");
    const held = await pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" });
    expect(held.state).toBe("awaiting_approval");
    const [gate] = await pipeline.approvals(id);
    expect(gate).toMatchObject({ decision: null, requested: { approvers: ["ana"], risk: { level: "high" } } });
    expect((await pipeline.events(id)).filter((e) => e.kind === "approval.partial")).toHaveLength(1);

    const done = await pipeline.decide(id, "approved", "ok", undefined, { approver: "bo" });
    expect(done.state).toBe("awaiting_ship");
    expect((await pipeline.approvals(id))[0]).toMatchObject({ decision: "approved", response: { approvers: ["ana", "bo"], approver: "bo" } });
  });

  it("forgets the first approver when the plan or the cases change: both names must approve the same plan", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", risk: { level: "high", scores: {} }, cases: [{ title: "t0", criterion: "c", approach: "a" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await pipeline.editPlan(task.id, { brief: "wider: migrate the users table" });
    expect((await pipeline.approvals(task.id))[0]!.requested.approvers).toEqual([]);
    // Bo is now the first approver of the edited plan, not the second of Ana's.
    expect((await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "bo" })).state).toBe("awaiting_approval");
    await pipeline.editCases(task.id, [{ title: "t1", criterion: "c", approach: "a" }]);
    expect((await pipeline.approvals(task.id))[0]!.requested.approvers).toEqual([]);
  });

  it("refuses the same name twice and a High-risk approval with no name, leaving the gate open", async () => {
    const id = await atGate("high");
    await expect(pipeline.decide(id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
    await pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" });
    await expect(pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" })).rejects.toBeInstanceOf(SameApproverError);
    expect((await pipeline.get(id)).state).toBe("awaiting_approval");
  });

  describe("from outside the owning team", () => {
    /** A pipeline whose CODEOWNERS says who owns what; the code map's own `owners` is whatever the mapper wrote. */
    const withCodeowners = (owners: string[] | null, codeowners = true, calls?: string[][]) =>
      new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, owners: async (_repo, paths) => (calls?.push(paths), owners === null ? null : { owners: owners.length ? [{ path: paths[0] ?? "a.ts", owners }] : [], codeowners }) });
    const atHigh = async (p: Pipeline, mapOwners: string[] = [], level: "high" | "low" = "high", extra: Record<string, unknown> = {}) => {
      stubs.reset();
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", risk: { level, scores: {} }, map: { components: [], files: [{ path: "a.ts", role: "change" }, { path: "r.ts", role: "read" }], entry_points: [], owners: mapOwners, confidence: 0.8 }, ...extra } });
      const task = await p.createTask({ title: "Billing", repoPath: "/r/a" });
      await p.start(task.id);
      return task.id;
    };

    it("refuses a second approver when both are CODEOWNERS' owners, and takes one from outside", async () => {
      const p = withCodeowners(["@ana", "@bo"]);
      const id = await atHigh(p);
      await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
      await expect(p.decide(id, "approved", undefined, undefined, { approver: "bo" })).rejects.toBeInstanceOf(OutsideApproverRequiredError);
      expect((await p.get(id)).state).toBe("awaiting_approval");
      expect((await p.approvals(id))[0]!.requested.approvers).toEqual(["ana"]);
      expect((await p.decide(id, "approved", undefined, undefined, { approver: "carla" })).state).toBe("awaiting_ship");
    });

    it("reads no owner a model wrote: a mapper that answers no owners, or a stranger, changes nothing", async () => {
      for (const mapOwners of [[], ["@nobody"]]) {
        const p = withCodeowners(["@ana", "@bo"]);
        const id = await atHigh(p, mapOwners);
        await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
        await expect(p.decide(id, "approved", undefined, undefined, { approver: "bo" })).rejects.toBeInstanceOf(OutsideApproverRequiredError);
      }
    });

    it("asks CODEOWNERS about the map's change and test files and the plan's step files, not the files it only reads", async () => {
      const calls: string[][] = [];
      const p = withCodeowners(["@ana"], true, calls);
      const id = await atHigh(p);
      await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
      expect(calls.at(-1)).toEqual(["a.ts"]);
    });

    it("lets an owner and a person from outside approve in either order", async () => {
      const p = withCodeowners(["@ana"]);
      const id = await atHigh(p);
      await p.decide(id, "approved", undefined, undefined, { approver: "carla" });
      expect((await p.decide(id, "approved", undefined, undefined, { approver: "ana" })).state).toBe("awaiting_ship");
    });

    it("skips the condition when the repo has no CODEOWNERS or no rule matches, and does not ask it of a plan that is not high", async () => {
      for (const p of [withCodeowners([]), withCodeowners(["@ana"], false)]) {
        const id = await atHigh(p);
        await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
        expect((await p.decide(id, "approved", undefined, undefined, { approver: "bo" })).state).toBe("awaiting_ship");
      }
      const low = withCodeowners(["@ana"]);
      const id = await atHigh(low, [], "low");
      expect((await low.decide(id, "approved", undefined, undefined, { approver: "ana" })).state).toBe("awaiting_ship");
    });

    it("keeps the owners the gate was opened with when CODEOWNERS cannot be read at approval time", async () => {
      const throwing = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, owners: async () => { throw new Error("boom"); } });
      const id = await atHigh(throwing, [], "high", { ruleOwners: { state: "ok", owners: ["@ana", "@bo"] } });
      await throwing.decide(id, "approved", undefined, undefined, { approver: "ana" });
      await expect(throwing.decide(id, "approved", undefined, undefined, { approver: "bo" })).rejects.toBeInstanceOf(OutsideApproverRequiredError);
      expect((await throwing.decide(id, "approved", undefined, undefined, { approver: "carla" })).state).toBe("awaiting_ship");
    });

    it("does not enforce the condition when the owners could not be read (no port, a null answer, a throw): two names still close it", async () => {
      const throwing = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, owners: async () => { throw new Error("boom"); } });
      for (const p of [pipeline, withCodeowners(null), throwing]) {
        const id = await atHigh(p, ["@ana"]);
        await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
        expect((await p.decide(id, "approved", undefined, undefined, { approver: "bo" })).state).toBe("awaiting_ship");
      }
    });
  });

  it("reads the rule from the gate as it is when the approval closes it: an edit that raised the risk is seen, and a race cannot approve past it", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [], risk: { level: "medium", scores: {} } } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.editPlan(task.id, { risk: { level: "high", reason: "billing" } });
    await expect(pipeline.decide(task.id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
    // Raced: whichever lands first, a task that reached the build had two names if the risk was high when it closed.
    stubs.reset();
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [], risk: { level: "medium", scores: {} } } });
    const racing = await newTask();
    await pipeline.start(racing.id);
    await Promise.allSettled([pipeline.decide(racing.id, "approved", undefined, undefined, { approver: "ana" }), pipeline.editPlan(racing.id, { risk: { level: "high", reason: "billing" } })]);
    const after = await pipeline.get(racing.id);
    const closed = (await pipeline.approvals(racing.id)).find((a) => a.decision === "approved");
    if (after.state !== "awaiting_approval" && closed) {
      const names = (closed.response as { approvers?: string[] } | null)?.approvers ?? [];
      const wasHigh = (closed.requested.risk as { level?: string }).level === "high";
      expect(!wasHigh || names.length >= 2).toBe(true);
    }
  });

  it("counts two simultaneous different approvers once each, never losing one", async () => {
    const id = await atGate("high");
    const results = await Promise.allSettled([
      pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" }),
      pipeline.decide(id, "approved", undefined, undefined, { approver: "bo" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await pipeline.get(id)).state).toBe("awaiting_ship");
    expect((await pipeline.approvals(id))[0]!.response).toMatchObject({ approvers: expect.arrayContaining(["ana", "bo"]) });
  });
});

describe("the preview gate follows ship.preview", () => {
  const pack = { summary: "s", format: "text" as const, scenarios: [], findings: [], outOfMap: [], risk: "low" as const, rollback: "revert", howToVerify: "run it", commitSha: "9c1f0e2a7b3d", media: [], at: "2026-11-04T00:00:00.000Z" };
  const walk = async (options: Record<string, unknown>) => {
    const p = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, ...options });
    const task = await p.createTask({ title: "Login page", criteria: ["Bad password shows an error"], evidence: pack });
    await p.start(task.id);
    await p.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    return { p, id: task.id };
  };

  it("with ship.preview off (the default) Evidence passes straight to shipping: no awaiting_ship gate is opened", async () => {
    const { p, id } = await walk({});
    expect((await p.get(id)).state).not.toBe("awaiting_ship");
    expect((await p.approvals(id)).some((a) => a.kind === "awaiting_ship")).toBe(false);
    expect((await p.stageRuns(id)).some((r) => r.stage === "shipping")).toBe(true);
  });

  it("with ship.preview on the card waits at awaiting_ship, and approving runs shipping", async () => {
    const { p, id } = await walk({ policies: previewOn });
    expect((await p.get(id)).state).toBe("awaiting_ship");
    expect((await p.stageRuns(id)).some((r) => r.stage === "shipping")).toBe(false);
    await p.decide(id, "approved");
    expect((await p.stageRuns(id)).some((r) => r.stage === "shipping")).toBe(true);
  });
});

describe("the ship approval (the release question after readiness)", () => {
  const pack = (risk: "low" | "high") => ({ summary: "s", format: "text" as const, scenarios: [], findings: [], outOfMap: [], risk, rollback: "revert", howToVerify: "run it", commitSha: "9c1f0e2a7b3d", media: [], at: "2026-11-04T00:00:00.000Z" });
  /** A task whose plan Ana approved and whose preview gate is approved: the watch then asks the release question with these details. */
  const atRelease = async (risk: "low" | "high", extra: Record<string, unknown> = {}) => {
    stubs.plan("awaiting_ship", { outcome: "needs_input", detail: { gate: "ship_approval", head: "h1", risk, question: "safe to release now?", ...extra } });
    const task = await pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"], evidence: pack(risk) });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
    await pipeline.decide(task.id, "approved");
    const open = (await pipeline.approvals(task.id)).find((a) => a.decision === null);
    expect(open?.requested.gate).toBe("ship_approval");
    return task.id;
  };

  it("the preview gate of a High-risk pack takes no name any more: the release question comes after readiness", async () => {
    stubs.plan("awaiting_ship", { outcome: "needs_input", detail: { gate: "ship_approval", head: "h1", risk: "high" } });
    const task = await pipeline.createTask({ title: "Billing", criteria: ["c"], evidence: pack("high") });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await expect(pipeline.decide(task.id, "approved")).resolves.toMatchObject({ state: "awaiting_ship" });
  });

  it("needs no name for a low-risk release question, and runs the merge on approval", async () => {
    const id = await atRelease("low");
    expect((await pipeline.decide(id, "approved")).state).toBe("closed");
    expect((await stagesRun(id)).slice(-2)).toEqual(["shipping", "reviewing_memory"]);
  });

  it("refuses a High-risk approval with no name, and leaves the question open", async () => {
    const id = await atRelease("high");
    await expect(pipeline.decide(id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
    await expect(pipeline.decide(id, "approved")).rejects.toThrow(/ship/);
    expect((await pipeline.get(id)).state).toBe("awaiting_ship");
  });

  it("refuses the plan's approver, with another case or a trailing space too", async () => {
    const id = await atRelease("high");
    await expect(pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" })).rejects.toBeInstanceOf(SameApproverError);
    await expect(pipeline.decide(id, "approved", undefined, undefined, { approver: "Ana " })).rejects.toBeInstanceOf(SameApproverError);
    expect((await pipeline.get(id)).state).toBe("awaiting_ship");
  });

  it("when the gate names release owners, only one of them may approve a High-risk card", async () => {
    const id = await atRelease("high", { releaseOwners: ["bo", "cy"] });
    await expect(pipeline.decide(id, "approved", undefined, undefined, { approver: "dee" })).rejects.toBeInstanceOf(NotReleaseOwnerError);
    expect((await pipeline.get(id)).state).toBe("awaiting_ship");
    const moved = await pipeline.decide(id, "approved", undefined, undefined, { approver: "BO" });
    expect(moved.state).toBe("closed");
  });

  it("keeps the approver and the head the question was asked about on the approval", async () => {
    const id = await atRelease("high");
    await pipeline.decide(id, "approved", undefined, undefined, { approver: "bo" });
    const gate = (await pipeline.approvals(id)).filter((a) => a.kind === "awaiting_ship" && a.requested.gate === "ship_approval").at(-1)!;
    expect(gate).toMatchObject({ decision: "approved", response: { approver: "bo", head: "h1" } });
  });

  it("a rejection archives the card with reason rejected and keeps the comment", async () => {
    const id = await atRelease("high");
    const out = await pipeline.decide(id, "rejected", "not today");
    expect(out).toMatchObject({ state: "archived", archiveReason: "rejected" });
    const gate = (await pipeline.approvals(id)).filter((a) => a.requested.gate === "ship_approval").at(-1)!;
    expect(gate).toMatchObject({ decision: "rejected", reason: "not today" });
    // The question is asked only when the checklist passes, so a rejection is a person refusing a ready PR: a row with checklist ids only (none failed).
    expect((await pipeline.events(id)).find((e) => e.kind === "ship.override")?.payload).toEqual({ kind: "rejected_ready", items: [] });
  });

  it("a person's send-back at the release question is refused: there is nothing to run again", async () => {
    const id = await atRelease("low");
    await expect(pipeline.decide(id, "sent_back", "redo")).rejects.toBeInstanceOf(TransitionError);
    expect((await pipeline.get(id)).state).toBe("awaiting_ship");
  });

  it("the preview gate is still not rejectable, and a send-back there runs Evidence again", async () => {
    const task = await pipeline.createTask({ title: "Login page", criteria: ["c"], evidence: pack("low") });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await expect(pipeline.decide(task.id, "rejected", "no")).rejects.toBeInstanceOf(RejectNotAllowedError);
    await pipeline.decide(task.id, "sent_back", "redo");
    expect((await pipeline.stageRuns(task.id)).filter((r) => r.stage === "evidence")).toHaveLength(2);
  });
});

describe("the open release question is probed once per poll interval", () => {
  const pack = { summary: "s", format: "text" as const, scenarios: [], findings: [], outOfMap: [], risk: "high" as const, rollback: "revert", howToVerify: "run it", commitSha: "9c1f0e2a7b3d", media: [], at: "2026-11-04T00:00:00.000Z" };
  const learned: string[] = [];
  const build = async (probe: (t: unknown, g: unknown) => Promise<"merged" | "closed" | "withdraw" | "keep">, shipProbeMs: number | null = 0) => {
    const truth = new DecisionTruth({ setTruth: async (p, id) => (learned.push(`${p}:${id}`), true), read: async () => ({ answer: {} }) as never }, { told: async () => {} });
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, shipGateProbe: probe as never, shipProbeMs, truth });
    stubs.plan("awaiting_ship", { outcome: "needs_input", detail: { gate: "ship_approval", head: "h1", risk: "high", decisions: { finding_classify: ["rec1"] } } });
    const task = await p.createTask({ title: "Billing", criteria: ["c"], evidence: pack });
    await p.start(task.id);
    await p.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await p.decide(task.id, "approved");
    learned.length = 0;
    expect((await p.approvals(task.id)).find((a) => a.decision === null)?.requested.gate).toBe("ship_approval");
    return { p, id: task.id };
  };

  it("a PR merged on GitHub closes the gate as an automatic approval: no name asked, no ground truth, and shipping records the merge", async () => {
    const { p, id } = await build(async () => "merged");
    await p.tick();
    const gate = (await p.approvals(id)).filter((a) => a.requested.gate === "ship_approval").at(-1)!;
    expect(gate).toMatchObject({ decision: "approved", response: { auto: true } });
    expect(learned).toEqual([]);
    expect((await stagesRun(id)).slice(-2)).toEqual(["shipping", "reviewing_memory"]);
  });

  it("a PR closed on GitHub archives the card with pr_closed", async () => {
    const { p, id } = await build(async () => "closed");
    await p.tick();
    expect(await p.get(id)).toMatchObject({ state: "archived", archiveReason: "pr_closed" });
  });

  it("a head that moved or a checklist that no longer passes withdraws the gate, and the watch runs again", async () => {
    const { p, id } = await build(async () => "withdraw");
    stubs.plan("awaiting_ship", { outcome: "pass" });
    const before = (await stagesRun(id)).filter((s) => s === "awaiting_ship").length;
    await p.tick();
    const gate = (await p.approvals(id)).filter((a) => a.requested.gate === "ship_approval")[0]!;
    expect(gate).toMatchObject({ decision: "sent_back", reason: "the PR changed: asked again when it is ready" });
    expect((await stagesRun(id)).filter((s) => s === "awaiting_ship").length).toBe(before + 1);
    expect(learned).toEqual([]);
  });

  it("keep leaves the gate alone, and the probe runs at most once per interval", async () => {
    const probe = vi.fn(async () => "keep" as const);
    const { p, id } = await build(probe, 60_000);
    await p.tick();
    await p.tick();
    expect(probe).toHaveBeenCalledTimes(1);
    expect((await p.get(id)).state).toBe("awaiting_ship");
    expect((await p.approvals(id)).find((a) => a.decision === null)).toBeDefined();
  });

  it("with no machine-wide interval the repository's ship.poll_minutes sets it (five by default)", async () => {
    const probe = vi.fn(async () => "keep" as const);
    const { p } = await build(probe, null);
    await p.tick();
    await p.tick();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a probe that throws leaves the gate open", async () => {
    const { p, id } = await build(async () => {
      throw new Error("github down");
    });
    await p.tick();
    expect((await p.approvals(id)).find((a) => a.decision === null)).toBeDefined();
  });

  it("a person's approval is ground truth for the finding records on the gate; a rejection writes none", async () => {
    const approved = await build(async () => "keep");
    await approved.p.decide(approved.id, "approved", undefined, undefined, { approver: "bo" });
    expect(learned).toEqual(["finding_classify:rec1"]);
    const rejected = await build(async () => "keep");
    await rejected.p.decide(rejected.id, "rejected", "no");
    expect(learned).toEqual([]);
  });

  it("does not probe the preview gate", async () => {
    const probe = vi.fn(async () => "merged" as const);
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, shipGateProbe: probe, shipProbeMs: 0 });
    const task = await p.createTask({ title: "Login", criteria: ["c"], evidence: pack });
    await p.start(task.id);
    await p.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await p.tick();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("decision truth at the plan gate", () => {
  const ids = { coverage_check: "rc", plan_check: "rp", risk_score: "rr" };
  const answers: Record<string, Record<string, unknown>> = {
    rc: { pins: { value: true, p: 0.9 }, redundancy: { score: 0, confidence: 0.8 }, untestable: { value: false, p: 0.1 } },
    rp: { fits_record: { score: 2, confidence: 0.9 }, risk_appropriate: { value: true, p: 0.9 } },
    rr: { blast_radius: { score: 0, confidence: 0.9 }, reversibility: { score: 0, confidence: 0.9 }, data_sensitivity: { score: 0, confidence: 0.9 }, complexity: { choice: "S", confidence: 0.9 } },
  };
  const setup = async (act: (p: Pipeline, id: string) => Promise<unknown>) => {
    const learned: Array<{ pack: string; recordId: string; label: unknown; source: string; taskId?: string }> = [];
    const truth = new DecisionTruth({ setTruth: async (pack, recordId, t) => (learned.push({ pack, recordId, label: t.label, source: t.source }), true), read: async (_pack, id) => ({ answer: answers[id]! }) as never }, { told: async () => {} });
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, truth });
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], cases: [{ title: "t", criterion: "c1", approach: "x" }], decisions: ids } });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    await act(p, task.id);
    return { learned, p, id: task.id };
  };

  it("confirms the three checks when the plan is approved untouched", async () => {
    const { learned } = await setup((p, id) => p.decide(id, "approved", undefined, undefined, { approver: "ana" }));
    expect(learned.map((l) => [l.pack, l.source]).sort()).toEqual([["coverage_check", "plan_approved"], ["plan_check", "plan_approved"], ["risk_score", "plan_approved"]]);
    expect(learned.find((l) => l.pack === "coverage_check")!.label).toEqual({ pins: { value: true }, redundancy: { score: 0 }, untestable: { value: false } });
  });

  it("contradicts coverage_check when the cases were edited, and the plan checks on a send-back", async () => {
    const edited = await setup(async (p, id) => {
      await p.editCases(id, [{ title: "t2", criterion: "c1", approach: "y" }] as never);
      await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
    });
    expect(edited.learned.find((l) => l.pack === "coverage_check")).toMatchObject({ source: "plan_edited", label: { pins: { value: false }, untestable: { value: true } } });
    expect(edited.learned.find((l) => l.pack === "plan_check")).toMatchObject({ source: "plan_approved" });
    const sent = await setup((p, id) => p.decide(id, "sent_back", "again"));
    expect(sent.learned.map((l) => l.source)).toEqual(["plan_sent_back", "plan_sent_back"]);
  });

  it("says a finding a person shipped with was not a blocker: the ship gate's finding_classify records get that truth, a send-back none", async () => {
    for (const decision of ["approved", "sent_back"] as const) {
      const { learned, p, id } = await setup(async (pl, taskId) => {
        stubs.plan("evidence", { outcome: "pass", detail: { evidence: { risk: "low" }, decisions: { finding_classify: ["f1", "f2"] } } });
        await pl.decide(taskId, "approved", undefined, undefined, { approver: "ana" });
      });
      learned.length = 0;
      if ((await p.get(id)).state === "awaiting_ship") await p.decide(id, decision, "r");
      if (decision === "approved") expect(learned.map((l) => [l.pack, l.recordId, l.label, l.source])).toEqual([["finding_classify", "f1", { severity: { choice: ["should_fix", "nit"] } }, "ship_approved"], ["finding_classify", "f2", { severity: { choice: ["should_fix", "nit"] } }, "ship_approved"]]);
      else expect(learned).toEqual([]);
    }
  });

  it("logs decision.truth on the task: ids and source, no payload", async () => {
    const { p, id } = await setup(async () => {});
    await p.logDecisionTruth(id, { pack: "worth_learning", recordId: "r1", source: "retro_approved" });
    expect((await p.events(id)).filter((e) => e.kind === "decision.truth").map((e) => e.payload)).toEqual([{ pack: "worth_learning", recordId: "r1", source: "retro_approved" }]);
  });

  it("learns nothing from an auto-approval", async () => {
    const { learned } = await setup((p, id) => p.decide(id, "approved", "auto", undefined, { auto: true }));
    expect(learned).toEqual([]);
  });
});

describe("the triage record: a correction and its ground truth", () => {
  const signals = { kind: { answer: "bug", confidence: 0.95 }, size: { answer: "S", confidence: 0.9 }, who: { answer: 1, confidence: 0.9 }, what: { answer: 1, confidence: 0.9 }, impact: { answer: 1, confidence: 0.9 }, time: { answer: 0, confidence: 0.9 }, demand: { answer: 0, confidence: 0.9 }, risk_prelim: { answer: "medium", confidence: 0.95 }, archive: { answer: false, confidence: 0.95 } };
  const classification = { kind: "bug", ready: true, size: 1, sizeBucket: "S" as const, typeOfWork: "backend" as const, priority: "P2" as const, riskPrelim: "medium" as const, subScores: { who: 2, what: 2, impact: 2, time: 1, demand: 1 }, confidence: 0.9, at: "2026-11-05T00:00:00.000Z", model: "m", recordId: "rt", signals };
  const setup = async (outcome = "plan") => {
    const learned: Array<{ pack: string; recordId: string; label: unknown; source: string }> = [];
    const truth = new DecisionTruth({ setTruth: async (pack, recordId, t) => (learned.push({ pack, recordId, label: t.label, source: t.source }), true), read: async () => null }, { told: async () => {} });
    stubs.plan("triage", { outcome: "pass", detail: { outcome, summary: "A bug.", reply: "Use pnpm dev.", archiveReason: "stale", record: { goal: "Fix it", reason: "r" } } });
    const saving = (stage: TaskState) => (stage === "triage" ? withTriageSignals(stubs.runnerFor(stage), { classify: null, save: (id, patch) => new PgTaskStore(db).updateTask(id, patch) }) : stubs.runnerFor(stage));
    const p = new Pipeline(db, saving, { inline: true, policies: previewOn, hasConfig: () => true, truth });
    const task = await p.createTask({ title: "Login page", classification });
    await p.start(task.id);
    return { p, id: task.id, learned };
  };

  it("keeps a priority edit where a calibration can find it, with the machine's level, the person's and the sub-scores; and not for a repository that keeps no truth", async () => {
    const written: Array<Record<string, unknown>> = [];
    for (const keeps of [true, false]) {
      const learned: unknown[] = [];
      const truth = new DecisionTruth({ setTruth: async () => true, read: async () => null }, { told: async () => {} });
      stubs.plan("triage", { outcome: "pass", detail: { outcome: "plan", summary: "A bug.", reply: "r", archiveReason: "stale", record: { goal: "Fix it", reason: "r" } } });
      const saving = (stage: TaskState) => (stage === "triage" ? withTriageSignals(stubs.runnerFor(stage), { classify: null, save: (id, patch) => new PgTaskStore(db).updateTask(id, patch) }) : stubs.runnerFor(stage));
      const p = new Pipeline(db, saving, { inline: true, policies: previewOn, hasConfig: () => true, truth, truthKept: async () => keeps, priorityTruth: async (e) => void written.push(e as never) });
      void learned;
      const task = await p.createTask({ title: "Login page", classification });
      await p.start(task.id);
      await p.editRecord(task.id, { priority: "P0" });
    }
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ machine: "triage", recordId: "rt", machineLevel: "P2", personLevel: "P0", subScores: { who: 2, what: 2, impact: 2, time: 1, demand: 1 } });
  });

  it("takes a correction at a gate: the version rises, the fields are the person's, and each is ground truth on the reading that said otherwise", async () => {
    const { p, id, learned } = await setup();
    const edited = await p.editRecord(id, { kind: "feature", size: "M", priority: "P0" });
    expect(edited.record).toMatchObject({ kind: "feature", size: "M", urgency: "P0", urgencyDetail: { priority: "P0" }, version: 2, decisionBy: "person", editedFields: ["kind", "size", "priority"] });
    expect(learned).toEqual([{ pack: "triage_signals", recordId: "rt", label: { kind: { choice: "feature" }, size: { choice: "M" } }, source: "record_edit" }]);
    expect((await p.events(id)).filter((e) => e.kind === "record.edited").map((e) => e.payload)).toEqual([{ fields: ["kind", "size", "priority"], version: 2 }]);
    // The same value again is no edit.
    await p.editRecord(id, { kind: "feature" });
    expect((await p.get(id)).record?.version).toBe(2);
  });

  it("keeps the machine's grade as the floor: a lower risk is stored and shown, a higher one applies at once", async () => {
    const { p, id, learned } = await setup();
    expect((await p.get(id)).record).toMatchObject({ riskPrelim: "medium", riskMachine: "medium", risk: "medium" });
    const lowered = await p.editRecord(id, { riskPrelim: "low" });
    expect(lowered.record).toMatchObject({ riskPrelim: "low", riskMachine: "medium", risk: "medium", editedFields: ["riskPrelim"] });
    expect(learned.at(-1)).toMatchObject({ pack: "triage_signals", label: { risk_prelim: { choice: "low" } }, source: "record_edit" });
    const raised = await p.editRecord(id, { riskPrelim: "high" });
    expect(raised.record).toMatchObject({ riskPrelim: "high", riskMachine: "medium", risk: "high" });
    // and back down: the floor is still the machine's, not the person's last value
    expect((await p.editRecord(id, { riskPrelim: "low" })).record).toMatchObject({ riskPrelim: "low", risk: "medium" });
  });

  it("a risk raised to High by a correction at the plan gate holds the plan for two names and drops the first approval", async () => {
    const { p, id } = await setup();
    const store = new PgTaskStore(db);
    const gate = (await p.approvals(id)).find((a) => a.decision === null)!;
    await store.withTaskLock(id, async (_t, tx) => tx.updateApprovalRequested(gate, { ...gate.requested, risk: { level: "low", scores: {} }, approvers: ["ana"] }));
    await p.editRecord(id, { riskPrelim: "high" });
    const open = (await p.approvals(id)).find((a) => a.decision === null)!;
    expect(open.requested).toMatchObject({ risk: { level: "high" }, approvers: [] });
    await expect(p.decide(id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
    expect((await p.decide(id, "approved", undefined, undefined, { approver: "bo" })).state).toBe("awaiting_approval");
    expect((await p.decide(id, "approved", undefined, undefined, { approver: "cy" })).state).not.toBe("awaiting_approval");
  });

  it("a correction to High at the plan gate recomputes the approval rule and the owners: the first approval for the lower level is void, High needs two different names", async () => {
    const { p, id } = await setup();
    const store = new PgTaskStore(db);
    const gate = (await p.approvals(id)).find((a) => a.decision === null)!;
    await store.withTaskLock(id, async (_t, tx) => tx.updateApprovalRequested(gate, { ...gate.requested, risk: { level: "low", machine: "low", scores: {} }, approvalRule: { needed: 1, outside: "none" }, approvers: ["ana"] }));
    await p.editRecord(id, { riskPrelim: "high" });
    const open = (await p.approvals(id)).find((a) => a.decision === null)!;
    expect(open.requested).toMatchObject({ risk: { level: "high" }, approvalRule: { needed: 2 }, approvers: [] });
    expect(open.requested.ruleOwners).toBeDefined();
    // ana's first approval, given for the lower level, is void: she counts once now, and the same name cannot close a High gate.
    expect((await p.decide(id, "approved", undefined, undefined, { approver: "ana" })).state).toBe("awaiting_approval");
    await expect(p.decide(id, "approved", undefined, undefined, { approver: "ana" })).rejects.toBeInstanceOf(SameApproverError);
    expect((await p.decide(id, "approved", undefined, undefined, { approver: "bo" })).state).not.toBe("awaiting_approval");
  });

  it("reads the card's own record risk at the decision too: a gate written before the correction still needs two names", async () => {
    const { p, id } = await setup();
    const store = new PgTaskStore(db);
    const gate = (await p.approvals(id)).find((a) => a.decision === null)!;
    await store.withTaskLock(id, async (_t, tx) => tx.updateApprovalRequested(gate, { ...gate.requested, risk: { level: "low", scores: {} } }));
    const task = await p.get(id);
    await store.updateTask(id, { record: { ...task.record!, risk: "high" } });
    await expect(p.decide(id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
  });

  it("corrects only at triage's questions and at the plan gate", async () => {
    const { p, id } = await setup();
    const record = (await p.get(id)).record;
    for (const state of ["escalated", "reviewing_memory", "awaiting_ship", "awaiting_test_check"] as const) {
      await new PgTaskStore(db).updateTask(id, { state });
      await expect(p.editRecord(id, { kind: "chore" }), state).rejects.toBeInstanceOf(RecordNotEditableError);
    }
    await new PgTaskStore(db).updateTask(id, { state: "awaiting_answers", record });
    expect((await p.editRecord(id, { kind: "chore" })).record?.kind).toBe("chore");
  });

  it("refuses a correction when there is no record or the card is not at a gate", async () => {
    const { p } = await setup();
    const bare = await p.createTask({ title: "No record yet" });
    await expect(p.editRecord(bare.id, { kind: "bug" })).rejects.toBeInstanceOf(RecordNotEditableError);
    const running = await p.createTask({ title: "Running", classification });
    await new PgTaskStore(db).updateTask(running.id, { state: "implementing", record: { source: "manual", kind: "bug", goal: "g", size: "S", urgency: "P2", risk: "low", signals: {}, qa: [], decision: "plan", reason: "r", at: "2026-11-05T00:00:00.000Z", model: "m" } });
    await expect(p.editRecord(running.id, { kind: "bug" })).rejects.toBeInstanceOf(RecordNotEditableError);
  });

  it("confirms the signals at proceed when the plan is approved with no edit, and lets a correction stand for its own question", async () => {
    const { p, id, learned } = await setup();
    await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
    const confirmed = learned.find((l) => l.source === "plan_approved" && l.pack === "triage_signals")!;
    expect(confirmed.label).toMatchObject({ kind: { choice: "bug" }, size: { choice: "S" }, risk_prelim: { choice: "medium" }, archive: { value: false }, who: { score: 1 }, time: { score: 0 } });
    const second = await setup();
    await second.p.editRecord(second.id, { kind: "chore" });
    await second.p.decide(second.id, "approved", undefined, undefined, { approver: "ana" });
    const withEdit = second.learned.filter((l) => l.source === "plan_approved").at(-1)!;
    expect(withEdit.label).toMatchObject({ kind: { choice: "chore" }, size: { choice: "S" } });
  });

  it("writes the outcome's truth when a reply or an archive gate is approved or sent back", async () => {
    const reply = await setup("conversation");
    await reply.p.decide(reply.id, "approved");
    expect(reply.learned.at(-1)).toMatchObject({ pack: "triage_signals", source: "triage_outcome_approved", label: { kind: { choice: "question" } } });
    const archive = await setup("archive");
    await archive.p.decide(archive.id, "sent_back", "no");
    expect(archive.learned.at(-1)).toMatchObject({ pack: "triage_signals", source: "triage_sent_back", label: { archive: { value: false } } });
  });
});

describe("ground truth", () => {
  const atGate = async (p: Pipeline) => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], cases: [{ title: "t", criterion: "c1", approach: "x" }] } });
    const task = await p.createTask({ title: "Login" });
    await p.start(task.id);
    return task.id;
  };

  it("hands the approved plan gate to the writer once it is closed, with who approved, and not on a send-back", async () => {
    const seen: Array<[string, string, unknown]> = [];
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, groundTruth: async (task, approval) => { seen.push([task.id, approval.decision ?? "open", approval.response]); return "/x.json"; } });
    const id = await atGate(p);
    await p.decide(id, "sent_back", "again");
    expect(seen).toEqual([]);
    await p.decide(id, "approved", undefined, undefined, { approver: "ana" });
    expect(seen).toEqual([[id, "approved", { approver: "ana" }]]);
    expect((await p.events(id)).filter((e) => e.kind === "ground_truth.written").map((e) => e.payload)).toEqual([{ path: "/x.json" }]);
  });

  it("writes no ground truth for a card whose repository keeps none (learning.truth: false)", async () => {
    let calls = 0;
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, groundTruth: async () => { calls += 1; return "/x.json"; }, truthKept: async () => false });
    const id = await atGate(p);
    expect((await p.decide(id, "approved")).state).toBe("awaiting_ship");
    expect(calls).toBe(0);
    expect((await p.events(id)).filter((e) => e.kind.startsWith("ground_truth"))).toEqual([]);
  });

  it("runs the stage inside the card's scope, so a decision call it makes carries the card's id", async () => {
    const seen: Array<string | undefined> = [];
    const p = new Pipeline(db, (stage) => async (input) => (seen.push(currentTask()), stubs.runnerFor(stage)(input)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await p.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    await p.start(task.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([task.id]));
    expect(currentTask()).toBeUndefined();
  });

  it("logs a writer that fails and approves anyway", async () => {
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, groundTruth: async () => { throw new Error("disk full"); } });
    const id = await atGate(p);
    expect((await p.decide(id, "approved")).state).toBe("awaiting_ship");
    expect((await p.events(id)).filter((e) => e.kind === "ground_truth.failed").map((e) => e.payload)).toEqual([{ error: "disk full" }]);
  });

  it("writes nothing for a reply or an archive gate, and nothing without a writer", async () => {
    let calls = 0;
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, groundTruth: async () => { calls += 1; return "/x.json"; } });
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "duplicate" } });
    const task = await p.createTask({ title: "dup" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    expect(calls).toBe(0);
    const bare = await atGate(pipeline);
    expect((await pipeline.decide(bare, "approved")).state).toBe("awaiting_ship");
  });

  it("keeps the scenario edit as a revision on the gate, so the proposal can be told from the approval", async () => {
    const id = await atGate(pipeline);
    const edited = [{ title: "edited", criterion: "c1", approach: "y" }];
    await pipeline.editCases(id, edited);
    const [gate] = await pipeline.approvals(id);
    expect(gate!.requested).toMatchObject({ cases: edited, revisions: [{ before: { cases: [{ title: "t" }] }, after: { cases: edited } }] });
  });
});

describe("triage outcomes", () => {
  const record = { kind: "question", goal: "answer how to run the board", size: "tiny", urgency: "normal", risk: "none", reason: "asks how, changes nothing" };

  it("waits at one gate for an archive, and approving it archives with the reason, skipping the plan stage", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "duplicate", record, brief: "same as #7" } });
    const task = await newTask();
    expect((await pipeline.start(task.id)).state).toBe("awaiting_approval");
    expect(await stagesRun(task.id)).toEqual(["triage"]);

    const archived = await pipeline.decide(task.id, "approved");
    expect(archived).toMatchObject({ state: "archived", archiveReason: "duplicate" });
    expect(await stagesRun(task.id)).toEqual(["triage"]);
    expect((await pipeline.approvals(task.id))[0]).toMatchObject({ kind: "awaiting_approval", decision: "approved" });
  });

  it("maps a reason the task does not keep onto the ones it does", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "stale", record } });
    const task = await newTask();
    await pipeline.start(task.id);
    expect(await pipeline.decide(task.id, "approved")).toMatchObject({ state: "archived", archiveReason: "rejected" });
  });

  it("records the reply on approving a conversation, then ends it closed", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "conversation", reply: "Use `pnpm dev`.", record } });
    const task = await newTask();
    expect((await pipeline.start(task.id)).state).toBe("awaiting_approval");

    const closed = await pipeline.decide(task.id, "approved");
    expect(closed).toMatchObject({ state: "closed", archiveReason: null });
    const events = await pipeline.events(task.id);
    const reply = events.find((e) => e.kind === "task.reply");
    expect(reply?.payload).toEqual({ body: "Use `pnpm dev`.", by: "person" });
    // The reply is posted only by the request that closed the gate: after the close, never before it.
    expect(events.findIndex((e) => e.kind === "task.reply")).toBeGreaterThan(events.findIndex((e) => e.kind === "transition" && e.payload.to === "closed"));
    expect(events.some((e) => e.kind === "transition" && e.payload.to === "archived")).toBe(false);
    // A second tap finds the gate shut and posts nothing more.
    await expect(pipeline.decide(task.id, "approved")).rejects.toThrow();
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.reply")).toHaveLength(1);
  });

  it("re-runs triage when an outcome gate is sent back, and the plan stage when the plan is", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "duplicate", record } });
    const task = await newTask();
    await pipeline.start(task.id);
    const again = await pipeline.decide(task.id, "sent_back", "it is not a duplicate");
    // The second triage run is the stub default: a plan outcome, so the plan stage runs and one approval waits.
    expect(again.state).toBe("awaiting_approval");
    expect(await stagesRun(task.id)).toEqual(["triage", "triage", "test_design"]);

    const resent = await pipeline.decide(task.id, "sent_back", "redo the scenarios");
    expect(resent.state).toBe("awaiting_approval");
    expect(await stagesRun(task.id)).toEqual(["triage", "triage", "test_design", "test_design"]);
  });
});

describe("the setup gate", () => {
  /** The real rule: a luna.yaml on disk. The other suites stub it as present. */
  const onDisk = (repoPath: string) => existsSync(join(repoPath, "luna.yaml"));
  const repoDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-repo-"));
    return dir;
  };

  it("runs setup before triage for a repo with no luna.yaml, and writes the approved file", async () => {
    const dir = repoDir();
    const written: Array<[string, string]> = [];
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: onDisk, writeConfig: async (repoPath, text) => void written.push([repoPath, text]) });
    stubs.plan("setup", { outcome: "pass", detail: { config: "checks: []\n", proof: [], summary: "nothing to run" } });
    const task = await p.createTask({ title: "Login page", repoPath: dir });
    const started = await p.start(task.id);
    expect(started.state).toBe("awaiting_setup");
    expect(await p.approvals(task.id)).toMatchObject([{ kind: "awaiting_setup", decision: null, requested: { config: "checks: []\n" } }]);

    const approved = await p.decide(task.id, "approved");
    expect(written).toEqual([[dir, "checks: []\n"]]);
    expect(approved.state).toBe("awaiting_approval");
    expect(await stagesRun(task.id)).toEqual(["setup", "triage", "test_design"]);
    expect((await p.events(task.id)).map((e) => e.kind)).toContain("config.written");
  });

  it("skips setup for a repo that already has a luna.yaml", async () => {
    const dir = repoDir();
    writeFileSync(join(dir, "luna.yaml"), "{}\n");
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: onDisk });
    const task = await p.createTask({ title: "Login page", repoPath: dir });
    expect((await p.start(task.id)).state).toBe("awaiting_approval");
    expect(await stagesRun(task.id)).toEqual(["triage", "test_design"]);
  });

  it("sends the proposal back with a note that re-runs setup, and closes a setup-only task once approved", async () => {
    const dir = repoDir();
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: onDisk, writeConfig: async () => {} });
    stubs.plan("setup", { outcome: "pass", detail: { config: "a: 1\n" } }, { outcome: "pass", detail: { config: "b: 2\n" } });
    const task = await p.setupRepo(dir);
    expect(task).toMatchObject({ route: "setup", state: "awaiting_setup", title: `Set up ${dir.split("/").pop()}` });

    await p.decide(task.id, "sent_back", "add the lint check");
    expect(await stagesRun(task.id)).toEqual(["setup", "setup"]);
    const closed = await p.decide(task.id, "approved");
    expect(closed.state).toBe("closed");
    const approvals = await p.approvals(task.id);
    expect(approvals.map((a) => [a.kind, a.decision, a.reason])).toEqual([
      ["awaiting_setup", "sent_back", "add the lint check"],
      ["awaiting_setup", "approved", null],
    ]);
  });

  it("escalates when setup fails, continuing at setup", async () => {
    const dir = repoDir();
    stubs.plan("setup", fail);
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: onDisk });
    const task = await p.createTask({ title: "Login page", repoPath: dir });
    expect(await p.start(task.id)).toMatchObject({ state: "escalated", resumeTo: "setup", reason: "setup failed" });
  });
});

describe("the whole pipeline with stub stages", () => {
  it("runs every stage once and closes after your three approvals", async () => {
    const task = await newTask();
    await startAndApprove(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");

    // The retro had nothing to propose: the second approval (the preview gate's) is the last click, the retro closes the card.
    const closed = await pipeline.decide(task.id, "approved");

    expect(closed.state).toBe("closed");
    expect(await stagesRun(task.id)).toEqual([
      "triage",
      "test_design",
      "implementing",
      "verifying",
      "e2e",
      "delivering",
      "ci_watch",
      "evidence",
      "awaiting_ship",
      "shipping",
      "reviewing_memory",
    ]);
    const approvals = await pipeline.approvals(task.id);
    expect(approvals.map((a) => a.kind)).toEqual(["awaiting_approval", "awaiting_ship"]);
    expect(approvals.every((a) => a.decision === "approved" && a.decidedAt)).toBe(true);
  });
});

describe("telemetry", () => {
  it("tells the telemetry about each stage run: a span in the task's session, the container when it starts, the outcome and usage when it ends", async () => {
    const { telemetry, spans } = recordingTelemetry();
    let traceEnvSeen: Record<string, string> | undefined;
    const triage: StageRunner = async ({ started, traceEnv }) => {
      traceEnvSeen = traceEnv;
      await started?.({ container: "hardness-abc-triage-1", inputCommit: "deadbeef", engine: "claude:opus" });
      return {
        outcome: "pass",
        detail: { summary: "a plan" },
        usage: { turns: 3, costUsd: 0.05 },
        events: [{ at: "2026-11-03T00:00:00.000Z", kind: "note", payload: { note: "hello" } }],
        run: { transcriptPath: "/state/runs/r1/transcript.log", info: { runtime: "claude", engine: "claude:opus", modelId: "claude-opus-5-5", sdk: { name: "sdk", version: "1" }, fingerprint: "b".repeat(64) } },
      };
    };
    const traced = new Pipeline(db, (stage) => (stage === "triage" ? triage : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true, telemetry });
    const task = await traced.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    await traced.start(task.id);
    const span = spans.find((s) => s.start.stage === "triage")!;
    expect(span.start).toMatchObject({ kind: "stage", pack: "triage", engine: null, sessionId: task.id, taskId: task.id, stage: "triage", attempt: 1 });
    expect(span.events.map((e) => e.name)).toEqual(["started", "note"]);
    expect(span.events[0]!.payload).toEqual({ container: "hardness-abc-triage-1", engine: "claude:opus" });
    expect(span.end).toMatchObject({ outcome: "pass", status: "passed", engine: "claude:opus", summary: "a plan", turns: 3, costUsd: 0.05, transcriptPath: "/state/runs/r1/transcript.log", info: { modelId: "claude-opus-5-5" } });
    expect(typeof span.end!.durationMs).toBe("number");
    expect(traceEnvSeen).toEqual({ LMNR_SPAN_CONTEXT: "ctx-1" });
    await traced.shutdown();
  });
});

describe("closing", () => {
  it("runs the close step after the last approval and logs the report", async () => {
    const seen: string[] = [];
    const closing = new Pipeline(db, stubs.runnerFor, {
      policies: previewOn,
      inline: true, hasConfig: () => true,
      closeDeps: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreeRemove: false,
        watcher: { close: async (id) => void seen.push(id) },
      },
    });
    const created = await closing.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    await closing.start(created.id);
    for (let i = 0; i < 2; i++) await closing.decide(created.id, "approved");

    expect((await closing.get(created.id)).state).toBe("closed");
    const event = (await closing.events(created.id)).find((e) => e.kind === "task.closed");
    const report = event?.payload as unknown as CloseReport;
    expect(report.steps.map((s) => s.step)).toEqual(["watch-tab", "worktree"]);
    expect(seen).toEqual([created.id]);
  });

  it("logs a failed step instead of failing the approval", async () => {
    const closing = new Pipeline(db, stubs.runnerFor, {
      policies: previewOn,
      inline: true, hasConfig: () => true,
      closeDeps: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreeRemove: false,
        watcher: { close: async () => Promise.reject(new Error("herdr down")) },
      },
    });
    const created = await closing.createTask({ title: "Login page", criteria: ["x"] });
    await closing.start(created.id);
    for (let i = 0; i < 2; i++) await closing.decide(created.id, "approved");

    expect((await closing.get(created.id)).state).toBe("closed");
    const event = (await closing.events(created.id)).find((e) => e.kind === "task.closed");
    expect((event?.payload as unknown as CloseReport).steps).toContainEqual(
      expect.objectContaining({ step: "watch-tab", ok: false }),
    );
  });
});

describe("memory review decision", () => {
  const closing = () =>
    new Pipeline(db, stubs.runnerFor, {
      policies: previewOn,
      inline: true, hasConfig: () => true,
      closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false },
    });

  async function toMemoryGate(p: Pipeline) {
    // The retro runs in reviewing_memory; with rules to propose the card waits there for a person.
    stubs.plan("reviewing_memory", { outcome: "pass", detail: { rules: { markdown: "- r\n" } } });
    const created = await p.createTask({ title: "Login page", criteria: ["x"] });
    await p.start(created.id);
    for (let i = 0; i < 2; i++) await p.decide(created.id, "approved");
    return created.id;
  }

  it("stores applyRules and the reason on the approval and skips the rules step", async () => {
    const p = closing();
    const id = await toMemoryGate(p);
    await p.decide(id, "approved", "rules skipped", { applyRules: false });

    const gate = (await p.approvals(id)).find((a) => a.kind === "reviewing_memory");
    expect(gate).toMatchObject({ decision: "approved", reason: "rules skipped", response: { applyRules: false } });
    const event = (await p.events(id)).find((e) => e.kind === "task.closed");
    const steps = (event?.payload as unknown as CloseReport).steps;
    expect(steps[0]).toMatchObject({ step: "rules", note: expect.stringMatching(/^skipped/) });
  });

  it("a retro with nothing to propose closes the card with no click; a retro that fails closes it too, and the reason is kept", async () => {
    const p = closing();
    stubs.plan("reviewing_memory", { outcome: "pass", detail: { rules: null, note: "no retro" } });
    const quiet = await p.createTask({ title: "Quiet", criteria: ["x"] });
    await p.start(quiet.id);
    for (let i = 0; i < 2; i++) await p.decide(quiet.id, "approved");
    expect((await p.get(quiet.id)).state).toBe("closed");
    expect((await p.events(quiet.id)).some((e) => e.kind === "task.closed")).toBe(true);
    expect((await p.approvals(quiet.id)).find((a) => a.kind === "reviewing_memory")).toBeUndefined();

    stubs.plan("reviewing_memory", { outcome: "fail", detail: { reason: "the retro broke" } });
    const broken = await p.createTask({ title: "Broken", criteria: ["x"] });
    await p.start(broken.id);
    for (let i = 0; i < 2; i++) await p.decide(broken.id, "approved");
    expect((await p.get(broken.id)).state).toBe("closed");
    expect((await p.events(broken.id)).some((e) => e.kind === "transition" && e.payload.to === "closed" && e.payload.reason === "the retro broke")).toBe(true);
  });

  it("a merged card's close writes the retro's truth, records only the misses the Build Report declared, and logs card.learned with counts", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const stateDir = await mkdtemp(join(tmpdir(), "retro-truth-"));
    const misses: string[][] = [];
    const facts = { predicted: { size: "small", risk: "low", estLoc: 10 }, actual: { added: 3, removed: 1, retries: { verify: 0, e2e: 0, ci: 0, total: 0 }, escalations: 0, format: "text", durationMin: 5, overrides: 0 }, runs: 3 };
    const p = new Pipeline(db, stubs.runnerFor, {
      policies: previewOn,
      inline: true, hasConfig: () => true,
      closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false },
      retroOutputs: { stateDir, facts: async () => facts, graph: { recordMisses: async (_repo: string, miss: { files: string[] }) => void misses.push(miss.files) }, declaredFiles: async () => ["src/a.ts"] },
    });
    stubs.plan("shipping", { outcome: "pass", detail: { merged: { sha: "m1" }, prUrl: "https://github.com/o/a/pull/7", number: 7 } });
    stubs.plan("reviewing_memory", { outcome: "pass", detail: { rules: { markdown: "- r\n", graphMisses: ["src/a.ts", "src/model-only.ts"], recalibration: [{ dimension: "size", predicted: "small", actual: "small", note: "fine" }] } } });
    const created = await p.createTask({ title: "Login page", criteria: ["x"], repoPath: "/r/a" });
    await p.start(created.id);
    for (let i = 0; i < 2; i++) await p.decide(created.id, "approved");
    await p.decide(created.id, "approved", undefined, { applyRules: false });
    expect(misses).toEqual([["src/a.ts"]]);
    const doc = JSON.parse(await readFile(join(stateDir, "ground-truth", "retro", `${created.id}.json`), "utf8"));
    expect(doc).toMatchObject({ schema: 1, retroRan: true, adopted: false, recalibration: [{ dimension: "size", note: "fine" }] });
    const events = await p.events(created.id);
    expect(events.find((e) => e.kind === "ground_truth.written")?.payload).toMatchObject({ kind: "retro" });
    expect(events.find((e) => e.kind === "card.learned")?.payload).toMatchObject({ misses: 1 });
  });

  it("a merged card teaches size_estimate the counted lines (no counted files: est_files stays unlabelled), reading the record from the plan stage's finish; a card that did not merge teaches nothing", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const stateDir = await mkdtemp(join(tmpdir(), "retro-size-"));
    const facts = { predicted: { size: "small", risk: "low", estLoc: 10 }, actual: { added: 30, removed: 10, retries: { verify: 0, e2e: 0, ci: 0, total: 0 }, escalations: 0, format: "text", durationMin: 5, overrides: 0 }, runs: 3 };
    const run = async (merged: boolean) => {
      const learned = vi.fn(async () => true);
      const p = new Pipeline(db, stubs.runnerFor, {
        policies: previewOn,
        inline: true, hasConfig: () => true,
        closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false },
        retroOutputs: { stateDir, facts: async () => facts },
        truth: { learned } as never,
      });
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["x"], decisions: { size_estimate: "rec-size", risk_score: "rec-risk" } } });
      stubs.plan("shipping", merged ? { outcome: "pass", detail: { merged: { sha: "m1" }, prUrl: "https://github.com/o/a/pull/7", number: 7 } } : { outcome: "pass", detail: {} });
      stubs.plan("reviewing_memory", { outcome: "pass", detail: { rules: { markdown: "- r\n", graphMisses: [] } } });
      const created = await p.createTask({ title: "Sized", criteria: ["x"], repoPath: "/r/a" });
      await p.start(created.id);
      for (let i = 0; i < 2; i++) await p.decide(created.id, "approved");
      await p.decide(created.id, "approved", undefined, { applyRules: false });
      return { learned, id: created.id };
    };
    const merged = await run(true);
    const calls = (merged.learned.mock.calls as unknown as Array<[{ pack: string }]>).map((c) => c[0]).filter((f) => f.pack === "size_estimate");
    expect(calls).toEqual([{ pack: "size_estimate", recordId: "rec-size", label: { est_loc: { score: 0 } }, kind: "fact", source: "merged_size", taskId: merged.id }]);
    const open = await run(false);
    expect((open.learned.mock.calls as unknown as Array<[{ pack: string }]>).filter((c) => c[0].pack === "size_estimate")).toEqual([]);
  });

  it("writes the retro file and the added-finding file for a repository that keeps truth, and neither for one that does not (learning.truth: false)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { existsSync } = await import("node:fs");
    const facts = { predicted: { size: "small", risk: "low", estLoc: 10 }, actual: { added: 3, removed: 1, retries: { verify: 0, e2e: 0, ci: 0, total: 0 }, escalations: 0, format: "text", durationMin: 5, overrides: 0 }, runs: 3 };
    const run = async (keeps: boolean) => {
      const stateDir = await mkdtemp(join(tmpdir(), "retro-gate-"));
      const p = new Pipeline(db, stubs.runnerFor, {
        policies: previewOn,
        inline: true, hasConfig: () => true,
        closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false },
        retroOutputs: { stateDir, facts: async () => facts },
        truthKept: async () => keeps,
      });
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["x"] } });
      stubs.plan("shipping", { outcome: "pass", detail: { merged: { sha: "m1" }, prUrl: "https://github.com/o/a/pull/7", number: 7 } });
      stubs.plan("reviewing_memory", { outcome: "pass", detail: { rules: { markdown: "- r\n", graphMisses: [] } } });
      const created = await p.createTask({ title: "Gate", criteria: ["x"], repoPath: "/r/a" });
      await p.start(created.id);
      await p.decide(created.id, "approved");
      expect((await p.get(created.id)).state).toBe("awaiting_ship");
      await p.addFinding(created.id, { title: "missed", severity: "nit" });
      const verify = existsSync(join(stateDir, "ground-truth", "verify"));
      await p.decide(created.id, "approved").catch(() => {});
      await p.decide(created.id, "approved", undefined, { applyRules: false }).catch(() => {});
      return { verify, retro: existsSync(join(stateDir, "ground-truth", "retro")), state: (await p.get(created.id)).state };
    };
    expect(await run(true)).toMatchObject({ verify: true, retro: true });
    expect(await run(false)).toMatchObject({ verify: false, retro: false });
  });

  it("offers the rules step by default when the gate carries rules", async () => {
    const p = closing();
    const id = await toMemoryGate(p);
    await p.decide(id, "approved");
    const event = (await p.events(id)).find((e) => e.kind === "task.closed");
    expect((event?.payload as unknown as CloseReport).steps.map((s) => s.step)[0]).toBe("rules");
  });
});

describe("acceptance criteria", () => {
  it("adopts triage's refined criteria when you approve the plan", async () => {
    const criteria = ["Bad password shows an error", "Five failures lock the account"];
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria } });
    const task = await newTask();
    await pipeline.start(task.id);

    const approved = await pipeline.decide(task.id, "approved");
    expect(approved.criteria).toEqual(criteria);
  });

  it("keeps the ticket's criteria when triage proposes none", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: [] } });
    const task = await newTask();
    await pipeline.start(task.id);

    const approved = await pipeline.decide(task.id, "approved");
    expect(approved.criteria).toEqual(["Bad password shows an error"]);
  });
});

describe("editing the plan before approving", () => {
  it("merges edited fields into the open plan approval, keeping what you didn't touch", async () => {
    const slices = [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }];
    stubs.plan("test_design", {
      outcome: "pass",
      detail: { brief: "old brief", criteria: ["c1"], assumptions: ["a1"], slices },
    });
    const task = await newTask();
    await pipeline.start(task.id);

    await pipeline.editPlan(task.id, { brief: "new brief", criteria: ["c1", "c2"] });

    const approval = (await pipeline.approvals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
    expect(approval?.requested).toMatchObject({ brief: "new brief", criteria: ["c1", "c2"], assumptions: ["a1"], slices });
  });

  it("keeps the v2.2 Plan in step with an edit: the version rises, the goal, criteria (their ids kept) and assumptions follow, nothing else moves", async () => {
    const plan = { goal: "old brief", steps: [{ id: "P1", title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }], acceptance_criteria: [{ id: "C1", text: "c1" }, { id: "C2", text: "c2" }], out_of_scope: ["x"], assumptions: ["a1"], rollback: "revert", version: 2 };
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "old brief", criteria: ["c1", "c2"], assumptions: ["a1"], plan } });
    const task = await newTask();
    await pipeline.start(task.id);

    await pipeline.editPlan(task.id, { brief: "new brief", criteria: ["c2", "c3"] });
    let approval = (await pipeline.approvals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
    expect(approval?.requested.plan).toEqual({ ...plan, goal: "new brief", acceptance_criteria: [{ id: "C2", text: "c2" }, { id: "C3", text: "c3" }], version: 3, next_criterion: 3 });
    // An edit that changes nothing is no revision.
    await pipeline.editPlan(task.id, { brief: "new brief" });
    approval = (await pipeline.approvals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
    expect((approval?.requested.plan as { version: number }).version).toBe(3);
  });

  describe("steps, rollback, risk and code map at the gate", () => {
    const slices = [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }];
    const plan = { goal: "g", steps: [{ id: "P1", title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }], acceptance_criteria: [{ id: "C1", text: "c1" }], out_of_scope: [], assumptions: [], rollback: "revert", version: 2 };
    const map = { components: ["c"], files: [{ path: "a.ts", role: "change" }], entry_points: [], owners: ["@ana"], confidence: 0.8 };
    const atGate = async (level: "low" | "medium" | "high" = "medium") => {
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [], slices, rollback: "revert", plan, map, cases: [{ id: "S1", title: "t", criterion: "c1", criterion_ref: "C1", approach: "x" }], risk: { level, product: 6, scores: {} } } });
      const task = await newTask();
      // The v2.2 plan is built from, so Build's entry contract wants the Triage record the real triage run saves.
      await new PgTaskStore(db).updateTask(task.id, { record: { goal: "g" } as never });
      await pipeline.start(task.id);
      return task.id;
    };
    const gate = async (id: string) => (await pipeline.approvals(id)).find((a) => a.decision === null)!;

    it("edits the steps (the slices Build reads follow, the Plan's steps and version too) and the rollback, keeping revisions", async () => {
      const id = await atGate();
      await pipeline.editPlan(id, { steps: [{ description: "Cap a coupon", files: ["a.ts", "b.ts"], done_when: ["c1 holds"], est_loc: 30 }], rollback: "git revert, then run the down migration" });
      const { requested } = await gate(id);
      expect(requested.slices).toEqual([{ title: "Cap a coupon", est_loc: 30, touchpoints: ["a.ts", "b.ts"], acceptance: ["c1 holds"] }]);
      expect(requested.rollback).toBe("git revert, then run the down migration");
      expect(requested.plan).toMatchObject({ version: 3, rollback: "git revert, then run the down migration", steps: [{ id: "P1", description: "Cap a coupon", files: ["a.ts", "b.ts"], done_when: ["c1 holds"] }] });
      expect(requested.revisions).toEqual([expect.objectContaining({ before: { slices, rollback: "revert" }, after: expect.objectContaining({ slices: [expect.objectContaining({ title: "Cap a coupon" })], rollback: "git revert, then run the down migration" }) })]);
    });

    it("raises the plan to high when edited steps touch the control plane, as the plan stage does, and holds it for two names", async () => {
      const id = await atGate("low");
      await pipeline.editPlan(id, { steps: [{ description: "Deploy it", files: ["src/a.ts", ".github/workflows/deploy.yml"], done_when: ["it ships"], est_loc: 10 }] });
      const { requested } = await gate(id);
      expect(requested.risk).toMatchObject({ level: "high", machine: "high" });
      expect(requested.approvalRule).toMatchObject({ needed: 2 });
      await expect(pipeline.decide(id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
      expect((await pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" })).state).toBe("awaiting_approval");
      // A lockfile or CODEOWNERS is the same; plain files leave a low plan low.
      const other = await atGate("low");
      await pipeline.editPlan(other, { steps: [{ description: "Bump", files: ["pnpm-lock.yaml"], done_when: ["x"], est_loc: 1 }] });
      expect((await gate(other)).requested.risk).toMatchObject({ level: "high" });
      const plain = await atGate("low");
      await pipeline.editPlan(plain, { steps: [{ description: "Edit", files: ["src/b.ts"], done_when: ["x"], est_loc: 1 }] });
      expect((await gate(plain)).requested.risk).toMatchObject({ level: "low" });
    });

    it("applies a raised risk at once: the level the approvers rule reads rises, the machine's own is kept, the reason is ground truth", async () => {
      const id = await atGate("medium");
      await pipeline.editPlan(id, { risk: { level: "high", reason: "touches billing" } });
      const { requested } = await gate(id);
      expect(requested.risk).toMatchObject({ level: "high", machine: "medium" });
      expect(requested.overrides).toMatchObject({ risk: { level: "high", reason: "touches billing", applied: true } });
      expect(requested.approvalRule).toMatchObject({ needed: 2 });
      // High now: one name no longer approves.
      expect((await pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" })).state).toBe("awaiting_approval");
    });

    it("keeps a lowered risk with its reason and shows it, while the approvers rule keeps reading the machine's level", async () => {
      const id = await atGate("high");
      await pipeline.editPlan(id, { risk: { level: "low", reason: "behind a flag" } });
      const { requested } = await gate(id);
      expect(requested.risk).toMatchObject({ level: "high", machine: "high" });
      expect(requested.overrides).toMatchObject({ risk: { level: "low", reason: "behind a flag", applied: false } });
      expect(requested.approvalRule).toMatchObject({ needed: 2 });
      await expect(pipeline.decide(id, "approved")).rejects.toBeInstanceOf(ApproverRequiredError);
    });

    it("keeps Ship's reading of the risk at the higher of the machine's and the edit", async () => {
      const id = await atGate("medium");
      await pipeline.editPlan(id, { risk: { level: "low", reason: "small" } });
      expect((await gate(id)).requested.risk).toMatchObject({ level: "medium" });
      await pipeline.editPlan(id, { risk: { level: "high", reason: "on second thought" } });
      expect((await gate(id)).requested.risk).toMatchObject({ level: "high" });
      await pipeline.editPlan(id, { risk: { level: "low", reason: "undone" } });
      expect((await gate(id)).requested.risk).toMatchObject({ level: "medium", machine: "medium" });
    });

    it("corrects the code map with a reason, recomputes who may approve from CODEOWNERS for the new files, and forgets the approvers so far", async () => {
      const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, owners: async (_r, paths) => ({ owners: paths.includes("b.ts") ? [{ path: "b.ts", owners: ["@bo"] }] : [{ path: "a.ts", owners: ["@ana"] }], codeowners: true }) });
      stubs.reset();
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [], slices, rollback: "revert", plan, map, risk: { level: "high", product: 6, scores: {} } } });
      const task = await p.createTask({ title: "Login page", criteria: ["c1"], repoPath: "/r/a" });
      await p.start(task.id);
      await p.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
      await p.editPlan(task.id, { map: { files: [{ path: "b.ts", role: "change" }], owners: ["@somebody-the-person-typed"], reason: "ownership moved" } });
      const { requested } = (await p.approvals(task.id)).find((a) => a.decision === null)!;
      expect(requested.map).toMatchObject({ components: ["c"], files: [{ path: "b.ts", role: "change" }], confidence: 0.8 });
      expect(requested.overrides).toMatchObject({ map: { reason: "ownership moved" } });
      expect(requested.approvers).toEqual([]);
      expect(requested.approvalRule).toMatchObject({ needed: 2, outside: "required", text: expect.stringMatching(/bo/) });
      expect(requested.approvalRule).toMatchObject({ text: expect.not.stringContaining("somebody") });
      expect(requested.ruleOwners).toMatchObject({ state: "ok", owners: ["@bo"] });
    });

    it("refuses steps, risk, map and rollback once the plan is approved (at the legacy test check), and still takes brief, criteria and assumptions", async () => {
      const id = await atGate("high");
      await pipeline.decide(id, "approved", undefined, undefined, { approver: "ana" });
      await pipeline.decide(id, "approved", undefined, undefined, { approver: "bo" });
      await db.query("delete from approvals where kind <> 'awaiting_approval'");
      await new PgTaskStore(db).updateTask(id, { state: "awaiting_test_check" });
      await db.manager.save(ApprovalEntity, db.manager.create(ApprovalEntity, { taskId: id, kind: "awaiting_test_check", requested: { cases: [] } }));
      const approved = (await pipeline.approvals(id)).find((a) => a.kind === "awaiting_approval")!;
      for (const patch of [{ steps: [{ description: "x", files: ["a.ts"], done_when: [], est_loc: 1 }] }, { risk: { level: "low" as const, reason: "r" } }, { map: { files: [], reason: "r" } }, { rollback: "none" }]) {
        await expect(pipeline.editPlan(id, patch), JSON.stringify(Object.keys(patch))).rejects.toBeInstanceOf(PlanApprovedError);
      }
      const unchanged = (await pipeline.approvals(id)).find((a) => a.id === approved.id)!;
      expect(unchanged.requested).toEqual(approved.requested);
      await pipeline.editPlan(id, { brief: "wider", criteria: ["c9"], assumptions: ["a"] });
      expect((await pipeline.approvals(id)).find((a) => a.id === approved.id)!.requested).toMatchObject({ brief: "wider", criteria: ["c9"] });
    });

    it("changes nothing and records nothing for an edit that matches what the gate has", async () => {
      const id = await atGate("medium");
      await pipeline.editPlan(id, { rollback: "revert" });
      expect((await gate(id)).requested.revisions).toBeUndefined();
      expect((await gate(id)).requested.plan).toMatchObject({ version: 2 });
    });
  });

  it("never hands a retired criterion id to a new criterion: C3 dropped, the next new one is C4, and an old scenario tied to C3 stays tied to nothing", async () => {
    const plan = { goal: "g", steps: [], acceptance_criteria: [{ id: "C1", text: "a" }, { id: "C2", text: "b" }, { id: "C3", text: "c" }], out_of_scope: [], assumptions: [], rollback: "r", version: 2, next_criterion: 3 };
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["a", "b", "c"], assumptions: [], plan, cases: [{ id: "S1", title: "t", criterion: "c", criterion_ref: "C3", approach: "x" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.editPlan(task.id, { criteria: ["a", "b"] });
    await pipeline.editPlan(task.id, { criteria: ["a", "b", "d"] });
    const gate = (await pipeline.approvals(task.id)).find((a) => a.decision === null)!;
    expect((gate.requested.plan as { acceptance_criteria: unknown }).acceptance_criteria).toEqual([{ id: "C1", text: "a" }, { id: "C2", text: "b" }, { id: "C4", text: "d" }]);
    expect(gate.requested.plan).toMatchObject({ next_criterion: 4 });
  });

  describe("a criteria edit recomputes coverage by id on the revised gate", () => {
    const plan = { goal: "g", steps: [], acceptance_criteria: [{ id: "C1", text: "a" }, { id: "C2", text: "b" }], out_of_scope: [], assumptions: [], rollback: "r", version: 2, next_criterion: 2 };
    const cases = [{ id: "S1", title: "t1", criterion: "a", criterion_ref: "C1", type: "happy", approach: "x" }, { id: "S2", title: "t2", criterion: "b", criterion_ref: "C2", type: "happy", approach: "x" }];
    const report = { score: 1, bar: 0.85, gaps: [], thin: [], untestable: [], open: [], per: [] };
    const atGate = async (extra: Record<string, unknown> = {}) => {
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["a", "b"], assumptions: [], plan, cases, coverageReport: report, flagged: ["plan outside map"], ...extra } });
      const task = await newTask();
      await pipeline.start(task.id);
      return task.id;
    };
    const gate = async (id: string) => (await pipeline.approvals(id)).find((a) => a.decision === null)!.requested;

    it("lists the new criterion that no scenario names and the scenario now tied to a criterion that is gone, and flags the gate", async () => {
      const id = await atGate();
      await pipeline.editPlan(id, { criteria: ["a", "c"] });
      const requested = await gate(id);
      expect(requested.coverageReport).toMatchObject({ score: 0.5, bar: 0.85, gaps: ["C3"], thin: [], per: [{ id: "C1", scenarios: ["S1"] }, { id: "C3", scenarios: [] }] });
      expect((requested.coverageReport as { open: string[] }).open).toEqual([expect.stringMatching(/C3 has no scenario: c/), expect.stringMatching(/S2 is tied to C2, which is no longer a criterion/)]);
      expect(requested.flagged).toEqual(["plan outside map", "coverage"]);
    });

    it("clears the coverage flag when the edit leaves every criterion covered and no scenario orphaned, keeping the other flags", async () => {
      const id = await atGate({ flagged: ["plan outside map", "coverage"] });
      await pipeline.editPlan(id, { criteria: ["b", "a"] });
      const requested = await gate(id);
      expect(requested.coverageReport).toMatchObject({ score: 1, gaps: [], open: [] });
      expect(requested.flagged).toEqual(["plan outside map"]);
    });

    it("matches a scenario with no ref by its criterion's text, and leaves a gate with no scenarios as it was", async () => {
      const id = await atGate({ cases: [{ title: "t1", criterion: "a", approach: "x" }, { title: "t2", criterion: "b", approach: "x" }], plan: undefined });
      await pipeline.editPlan(id, { criteria: ["a", "b2"] });
      expect((await gate(id)).coverageReport).toMatchObject({ gaps: ["C2"], score: 0.5 });
      stubs.reset();
      stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["a"], assumptions: [], cases: [] } });
      const bare = await newTask();
      await pipeline.start(bare.id);
      await pipeline.editPlan(bare.id, { criteria: ["a", "z"] });
      expect(await gate(bare.id)).not.toHaveProperty("coverageReport");
    });

    it("does not touch coverage for an edit that leaves the criteria alone", async () => {
      const id = await atGate();
      await pipeline.editPlan(id, { brief: "other" });
      expect((await gate(id)).coverageReport).toEqual(report);
    });
  });

  it("edits a gate written before the v2.2 Plan (no `plan` key) as it always did", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "old", criteria: ["c1"], assumptions: [] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.editPlan(task.id, { brief: "new" });
    const approval = (await pipeline.approvals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
    expect(approval?.requested).toMatchObject({ brief: "new" });
    expect(approval?.requested).not.toHaveProperty("plan");
  });

  it("is what gets adopted once you approve", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [] } });
    const task = await newTask();
    await pipeline.start(task.id);

    await pipeline.editPlan(task.id, { criteria: ["edited criterion"] });
    const approved = await pipeline.decide(task.id, "approved");
    expect(approved.criteria).toEqual(["edited criterion"]);
  });

  it("rejects editing when there is no open plan to edit", async () => {
    const task = await newTask();
    await expect(pipeline.editPlan(task.id, { brief: "x" })).rejects.toThrow(/no plan/i);
  });

  it("rejects editing an answers gate", async () => {
    stubs.plan("triage", { outcome: "needs_input", detail: { questions: [{ question: "q", recommended: "r" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await expect(pipeline.editPlan(task.id, { brief: "x" })).rejects.toThrow(/no plan/i);
  });

  it("keeps a revision of what changed and logs the edited fields, instead of overwriting silently", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "old", criteria: ["c1"], assumptions: ["a1"] } });
    const task = await newTask();
    await pipeline.start(task.id);

    await pipeline.editPlan(task.id, { brief: "new", criteria: ["c1"], assumptions: ["a2"] });

    const approval = (await pipeline.approvals(task.id)).find((a) => a.kind === "awaiting_approval");
    expect(approval?.requested).toMatchObject({
      brief: "new",
      assumptions: ["a2"],
      revisions: [{ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), before: { brief: "old", assumptions: ["a1"] }, after: { brief: "new", assumptions: ["a2"] } }],
    });
    const edited = (await pipeline.events(task.id)).filter((e) => e.kind === "plan.edited");
    expect(edited.map((e) => e.payload)).toEqual([{ fields: ["brief", "assumptions"], gate: "awaiting_approval" }]);
  });
});

describe("editing the test cases", () => {
  const designed = [{ title: "old", criterion: "c1", approach: "a" }];

  it("rejects editing cases at a gate that carries none, and before any gate is open", async () => {
    stubs.plan("triage", { outcome: "needs_input", detail: { questions: [{ question: "q", recommended: "r" }] } });
    const task = await newTask();
    await expect(pipeline.editCases(task.id, designed)).rejects.toThrow(/no test cases/i);
    await pipeline.start(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_answers");
    await expect(pipeline.editCases(task.id, designed)).rejects.toThrow(/no test cases/i);
  });
});

describe("gates", () => {
  it("asks triage's questions and re-runs triage with your answers", async () => {
    stubs.plan("triage", {
      outcome: "needs_input",
      detail: { questions: ["Email or username?"] },
    });
    const task = await newTask();

    const asking = await pipeline.start(task.id);
    expect(asking.state).toBe("awaiting_answers");
    const [question] = await pipeline.approvals(task.id);
    expect(question?.requested).toEqual({ questions: ["Email or username?"] });

    const answered = await pipeline.answer(task.id, { "Email or username?": "Email" });
    expect(answered.state).toBe("awaiting_approval");
    expect((await pipeline.approvals(task.id))[0]).toMatchObject({
      decision: "answered",
      response: { answers: { "Email or username?": "Email" } },
    });
    expect(await stagesRun(task.id)).toEqual(["triage", "triage", "test_design"]);
  });

  it("re-runs triage when you send the plan back, keeping your reason", async () => {
    const task = await newTask();
    await pipeline.start(task.id);
    const sentBack = await pipeline.decide(task.id, "sent_back", "Split it into two tickets");

    expect(sentBack.state).toBe("awaiting_approval");
    expect((await pipeline.approvals(task.id))[0]).toMatchObject({
      decision: "sent_back",
      reason: "Split it into two tickets",
    });
  });
});

describe("the verifying findings loop", () => {
  it("gives the next implementing run the findings of the latest verifying run", async () => {
    const finding = (title: string) => ({
      path: "a.ts", line: 1, start_line: null, severity: "bug", title, body: "", suggestion_code: null, confidence: 1,
    });
    const seen: Array<string[] | undefined> = [];
    const runner = (stage: TaskState): StageRunner => {
      if (stage === "implementing") {
        return async (context) => {
          seen.push(context.priorFindings?.map((f) => f.title));
          return { outcome: "pass" };
        };
      }
      return stubs.runnerFor(stage);
    };
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    stubs.plan(
      "verifying",
      { outcome: "fail", detail: { findings: [finding("first")] } },
      { outcome: "fail", detail: { findings: [finding("second")] } },
    );
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual([[], ["first"], ["second"]]);
  });
});

describe("the ci_watch findings loop", () => {
  it("gives implementing the findings of a failed ci_watch run", async () => {
    const finding = (title: string) => ({
      path: "a.ts", line: 1, start_line: null, severity: "bug", title, body: "", suggestion_code: null, confidence: 1,
    });
    const seen: Array<string[] | undefined> = [];
    const runner = (stage: TaskState): StageRunner => {
      if (stage === "implementing") {
        return async (context) => {
          seen.push(context.priorFindings?.map((f) => f.title));
          return { outcome: "pass" };
        };
      }
      return stubs.runnerFor(stage);
    };
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    stubs.plan("ci_watch", { outcome: "fail", detail: { findings: [finding("ci red")] } });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual([[], ["ci red"]]);
  });
});

describe("the implementing findings loop", () => {
  it("carries findings a failed run reports at the top level, the way the pack runner does", async () => {
    const finding = (title: string) => ({
      path: "junk.txt", line: 0, start_line: null, severity: "risk", title, body: "", suggestion_code: null, confidence: 1,
    });
    const seen: Array<string[] | undefined> = [];
    let attempts = 0;
    const runner = (stage: TaskState): StageRunner => {
      if (stage === "implementing") {
        return async (context) => {
          seen.push(context.priorFindings?.map((f) => f.title));
          attempts += 1;
          if (attempts === 1) return { outcome: "fail", detail: { error: "left uncommitted changes" }, findings: [finding("left uncommitted")] };
          return { outcome: "pass" };
        };
      }
      return stubs.runnerFor(stage);
    };
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual([[], ["left uncommitted"]]);
  });

  it("gives Build the failed scenarios of a browser run that sent the card back, not the last Verify pass's findings", async () => {
    const finding = (title: string) => ({ path: "", line: 0, start_line: null, severity: "blocker", title, body: "", suggestion_code: null, confidence: 1 });
    const seen: Array<string[] | undefined> = [];
    let e2eRuns = 0;
    const runner = (stage: TaskState): StageRunner => {
      if (stage === "implementing") {
        return async (context) => {
          seen.push(context.priorFindings?.map((f) => f.title));
          return { outcome: "pass" };
        };
      }
      if (stage === "verifying") return async () => ({ outcome: "pass", findings: [finding("leftover verify nit")] });
      if (stage === "e2e") {
        return async () => (++e2eRuns === 1 ? { outcome: "fail", detail: {}, findings: [finding("scenario failed: login works")] } : { outcome: "pass" });
      }
      return stubs.runnerFor(stage);
    };
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen[1]).toEqual(["scenario failed: login works"]);
  });

  it("feeds Deliver the open findings Verify left, from the rows of the stages before it", async () => {
    const soft = { path: "a.ts", line: 3, start_line: null, severity: "should_fix", title: "add a test", body: "b", suggestion_code: null, confidence: 0.9 };
    let seen: unknown;
    const runner = (stage: TaskState): StageRunner => {
      if (stage === "verifying") return async () => ({ outcome: "pass", detail: { findings: [soft] }, findings: [soft] });
      if (stage === "delivering") {
        return async (context) => {
          seen = context.prFacts?.findings.map((f) => f.title);
          return stubs.runnerFor(stage)(context);
        };
      }
      return stubs.runnerFor(stage);
    };
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual(["add a test"]);
  });

  it("gives the next implementing attempt the findings its own failed run left", async () => {
    const finding = (title: string) => ({
      path: "test/a.test.ts", line: 0, start_line: null, severity: "test", title, body: "", suggestion_code: null, confidence: 1,
    });
    const seen: Array<string[] | undefined> = [];
    let attempts = 0;
    const runner = (stage: TaskState): StageRunner => {
      if (stage === "implementing") {
        return async (context) => {
          seen.push(context.priorFindings?.map((f) => f.title));
          attempts += 1;
          // A locked test file was changed: the run fails and names it (agents.ts).
          if (attempts === 1) return { outcome: "fail", detail: { findings: [finding("locked test file changed")] } };
          return { outcome: "pass" };
        };
      }
      return stubs.runnerFor(stage);
    };
    pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual([[], ["locked test file changed"]]);
  });
});

describe("retries and escalation", () => {
  it("takes the browser run's cap from the repository's verify.e2e_rounds", async () => {
    stubs.plan("e2e", { outcome: "fail", detail: {} }, { outcome: "fail", detail: {} });
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: { for: async () => ({ ...DEFAULT_POLICY, factory: factoryConfigOf({ verify: { e2e_rounds: 2 } }) }) } });
    const task = await newTask();
    expect(await startAndApprove(task.id)).toMatchObject({ state: "escalated", reason: "e2e failed 2 times" });
  });

  it("asks a person when Verify sends Build the same set of blocker findings twice (verify.build_rounds is 1)", async () => {
    const blocked = { outcome: "fail" as const, detail: {}, findings: [{ path: "a.ts", line: 3, severity: "blocker", title: "off by one", body: "b", confidence: 0.9 }] };
    stubs.plan("verifying", blocked, blocked);
    const task = await newTask();
    const escalated = await startAndApprove(task.id);
    expect(escalated).toMatchObject({ state: "escalated", reason: expect.stringMatching(/same findings came back after 1 round/) });
    expect(escalated.retries).toMatchObject({ verify: 2 });
  });

  it("escalates after three verify failures, then resumes with your guidance", async () => {
    stubs.plan("verifying", fail, fail, fail);
    const task = await newTask();

    const escalated = await startAndApprove(task.id);
    expect(escalated).toMatchObject({ state: "escalated", reason: "verify failed 3 times" });
    expect(escalated.retries).toMatchObject({ verify: 3, total: 3 });
    const runs = await pipeline.stageRuns(task.id);
    expect(runs.filter((r) => r.stage === "verifying").map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(runs.filter((r) => r.stage === "verifying").every((r) => r.status === "failed")).toBe(
      true,
    );

    const resumed = await pipeline.decide(task.id, "approved", "Mock the clock in the test");
    expect(resumed.state).toBe("awaiting_ship");
    expect(resumed.reason).toBeNull();
  });

  it("escalates with the agent's own reason when it stops on purpose, without verifying", async () => {
    stubs.plan("implementing", { outcome: "escalated", detail: { reason: "the plan needs a new dependency" } });
    const task = await newTask();

    const escalated = await startAndApprove(task.id);
    expect(escalated).toMatchObject({ state: "escalated", reason: "the plan needs a new dependency", resumeTo: "implementing" });
    expect(await stagesRun(task.id)).not.toContain("verifying");
    const run = (await pipeline.stageRuns(task.id)).find((r) => r.stage === "implementing");
    expect(run).toMatchObject({ status: "failed", outcome: "escalated" });
  });

  it("runs implementing once more on a stronger engine after too_complex, and asks a person after a second", async () => {
    const engines: Array<EngineId | undefined> = [];
    const tooComplex: StageResult = { outcome: "escalated", detail: { reason: "spans six modules", escalation: "too_complex" } };
    const implementing = (results: StageResult[]): StageRunner => async ({ engine }) => {
      engines.push(engine);
      return results.shift() ?? { outcome: "pass" };
    };
    const once = implementing([tooComplex, { outcome: "pass" }]);
    pipeline = new Pipeline(db, (stage) => (stage === "implementing" ? once : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const first = await startAndApprove((await newTask()).id);
    expect(first.state).not.toBe("escalated");
    expect(first.retries).not.toHaveProperty("strongerNext");
    expect(engines).toEqual([undefined, "claude:opus"]);
    expect((await pipeline.events(first.id)).find((e) => e.kind === "stage.engine")?.payload).toMatchObject({ stage: "implementing", engine: "claude:opus", reason: "one shot on a stronger engine after too_complex" });

    engines.length = 0;
    const twice = implementing([tooComplex, tooComplex]);
    pipeline = new Pipeline(db, (stage) => (stage === "implementing" ? twice : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const second = await startAndApprove((await newTask()).id);
    expect(second).toMatchObject({ state: "escalated", reason: "spans six modules" });
    expect(engines).toEqual([undefined, "claude:opus"]);
  });

  it("treats a runner that throws as a failed run", async () => {
    const throwing: StageRunner = async () => {
      throw new Error("container exited with 137");
    };
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? throwing : stubs.runnerFor(stage)), {
      policies: previewOn,
      inline: true, hasConfig: () => true,
    });
    const task = await newTask();

    const escalated = await pipeline.start(task.id);
    expect(escalated).toMatchObject({ state: "escalated", reason: "triage failed" });
    const finished = (await pipeline.events(task.id)).find((e) => e.kind === "stage.finished");
    expect(finished?.payload).toMatchObject({ status: "failed", error: "container exited with 137" });
  });
});

describe("a test change a person approves", () => {
  it("carries the request to the replan, and unlocks the test it names for the next Build once the plan is approved", async () => {
    const seen: Array<{ stage: string; ctx: StageContext }> = [];
    const runnerFor = (stage: TaskState): StageRunner => async (ctx) => (seen.push({ stage, ctx }), stubs.runnerFor(stage)(ctx));
    pipeline = new Pipeline(db, runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, revertCommit: async () => {} });
    const request = "In site/src/components/landing/static-sections.test.tsx, the Pricing test asserts the old suffix '+ your Claude'; change it to read the plan's suffix.";
    stubs.plan(
      "implementing",
      { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } },
      { outcome: "test_change", detail: { request, summary: "a locked test pins the old suffix", reason: "the implementer asks to change a locked test: a locked test pins the old suffix" } },
    );
    stubs.plan("verifying", { outcome: "fail", run: { inputCommit: "aaa", outputCommit: "bbb" }, detail: { findings: [] } });
    const task = await newTask();
    expect((await startAndApprove(task.id)).state).toBe("awaiting_approval");
    // The replan read the request, word for word.
    const replanned = seen.filter((s) => s.stage === "test_design").at(-1)!.ctx;
    expect(replanned.replan?.reason).toContain("static-sections.test.tsx");
    const asked = (await pipeline.events(task.id)).find((e) => e.kind === "transition" && e.payload.outcome === "test_change");
    expect(asked?.payload.reason).toMatch(/asks to change a locked test/);
    // A person approves the new plan: the next Build may change exactly that test.
    await pipeline.decide(task.id, "approved");
    const next = seen.filter((s) => s.stage === "implementing").at(-1)!.ctx;
    expect(next.unlockedTests).toEqual(["site/src/components/landing/static-sections.test.tsx"]);
  });

  it("unlocks nothing before a plan is approved after the request", async () => {
    expect(testPathsIn("no test is named here")).toEqual([]);
    expect(testPathsIn("change web/cart.test.ts and docs/api.md; not ../x.test.ts or /abs/y.test.ts")).toEqual(["web/cart.test.ts"]);
  });
});

describe("test_change undoes verifying's tests", () => {
  it("reverts the commit verifying's tests came in on before test_design re-plans, so the wrong test is not locked in", async () => {
    const reverted: Array<[string, string]> = [];
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, revertCommit: async (worktree, sha) => void reverted.push([worktree, sha]) });
    stubs.plan(
      "implementing",
      { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } },
      { outcome: "test_change", detail: { request: "the empty-cart test asserts the wrong text" } },
    );
    stubs.plan("verifying", { outcome: "fail", run: { inputCommit: "aaa", outputCommit: "bbb" }, detail: { findings: [] } });
    const task = await newTask();
    const after = await startAndApprove(task.id);
    // Inline, the loop went straight on into test_design, which the stub answered.
    expect(after.state).toBe("awaiting_approval");
    expect(reverted).toEqual([["/wt/x", "bbb"]]);
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("tests.reverted");
  });

  it("escalates when the revert fails, instead of sending the task round a loop it cannot win", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, revertCommit: async () => { throw new Error("conflict in test/cart.test.js"); } });
    stubs.plan(
      "implementing",
      { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } },
      { outcome: "test_change", detail: { request: "wrong test" } },
    );
    stubs.plan("verifying", { outcome: "fail", run: { inputCommit: "aaa", outputCommit: "bbb" }, detail: { findings: [] } });
    const task = await newTask();
    const after = await startAndApprove(task.id);
    expect(after.state).toBe("escalated");
    expect(after.reason).toMatch(/could not revert verifying's tests bbb/);
  });
});

describe("the card triad", () => {
  it("records tests passed/total from verifying's results and the diff of a writable pass on the task", async () => {
    const diffs: string[] = [];
    pipeline = new Pipeline(db, stubs.runnerFor, {
      policies: previewOn,
      inline: true, hasConfig: () => true,
      diffStat: async (worktree, repoPath) => {
        diffs.push(`${worktree}@${repoPath}`);
        return { added: 142, removed: 18 };
      },
    });
    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" }, run: { inputCommit: "base1", outputCommit: "out1" } });
    const cases = [{ title: "a", ok: true }, { title: "b", ok: false }, { title: "c", ok: true }];
    stubs.plan("verifying", {
      outcome: "pass",
      detail: { step: "review", results: [{ title: "a", outcome: "pass" }, { title: "b", outcome: "fail" }, { title: "c", outcome: "pass" }], cases },
    });
    const task = await newTask();
    await startAndApprove(task.id);
    const row = await pipeline.get(task.id);
    expect(row).toMatchObject({ diffAdded: 142, diffRemoved: 18, testsPassed: 2, testsTotal: 3 });
    expect(diffs).toEqual(["/wt/x@null"]);
    const runs = await pipeline.stageRuns(task.id);
    expect(runs.find((r) => r.stage === "verifying")?.cases).toEqual(cases);
    expect(runs.find((r) => r.stage === "implementing")?.cases).toBeNull();
  });
});

describe("spend per task", () => {
  it("sums each task's stage runs, so a list can mark the expensive tickets", async () => {
    const a = await newTask();
    const b = await newTask();
    for (const [id, cost] of [[a.id, "0.40"], [a.id, "0.10"], [b.id, null]] as const) {
      await db.query(
        "insert into stage_runs (task_id, stage, attempt, status, started_at, cost_usd) values ($1, 'triage', 1, 'passed', now(), $2)",
        [id, cost],
      );
    }
    await db.query("update stage_runs set ended_at = started_at + interval '90 seconds' where task_id = $1", [a.id]);
    const usage = await pipeline.usageByTask();
    expect(usage.get(a.id)?.spentUsd).toBeCloseTo(0.5);
    expect(usage.get(a.id)?.workedMs).toBe(180_000);
    expect(usage.get(b.id)).toMatchObject({ spentUsd: 0 });
    expect((await pipeline.taskUsage(a.id)).spentUsd).toBeCloseTo(0.5);
  });
});

describe("the stuck detector", () => {
  const same = { outcome: "fail" as const, detail: { error: "implementer left uncommitted changes: ?? .cache/x/slices.json" } };

  it("escalates a stage that fails the same way three times instead of spending the whole retry cap", async () => {
    stubs.plan("implementing", same, same, same);
    const task = await newTask();
    const escalated = await startAndApprove(task.id);
    expect(escalated).toMatchObject({ state: "escalated", resumeTo: "implementing" });
    expect(escalated.reason).toMatch(/stuck: implementing failed the same way 3 times/);
    expect(escalated.reason).toContain("slices.json");
    expect((await pipeline.stageRuns(task.id)).filter((r) => r.stage === "implementing")).toHaveLength(3);
  });

  it("keeps retrying while the failures differ", async () => {
    stubs.plan(
      "implementing",
      { outcome: "fail", detail: { error: "one" } },
      { outcome: "fail", detail: { error: "two" } },
      { outcome: "fail", detail: { error: "three" } },
    );
    const task = await newTask();
    const done = await startAndApprove(task.id);
    expect(done.state).not.toBe("escalated");
    expect((await pipeline.stageRuns(task.id)).filter((r) => r.stage === "implementing")).toHaveLength(4);
  });
});

describe("the token economy around a stage", () => {
  const stuck = { outcome: "fail" as const, detail: { error: `${LOOP_STUCK}: the same test fails after each edit, the same failure 4 times over 31 calls`, runFailed: true } };
  const fake = (over: Partial<Economy> = {}) => {
    const folded: Parameters<Economy["afterRun"]>[0][] = [];
    const economy: Economy = { ...noEconomy(), afterRun: async (run) => void folded.push(run), ...over };
    return { folded, economy };
  };
  const build = (economy: Economy, implementing: StageRunner, decide: unknown = null) =>
    new Pipeline(db, (stage) => (stage === "implementing" ? implementing : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true, economy, escalationDecide: { decide: decide as never } });
  const approvedCard = async (p: Pipeline) => {
    const task = await p.createTask({ title: "Login", repoPath: "/r/a" });
    await p.start(task.id);
    await p.decide(task.id, "approved");
    return task.id;
  };

  it("leaves folding to the pack runner: a stage run is not folded a second time under its stage", async () => {
    const { folded, economy } = fake();
    const p = build(economy, async () => ({ outcome: "pass" as const, usage: { turns: 3, costUsd: 0.1, tokens: { input: 10, output: 2, cached: 5 } } }));
    const id = await approvedCard(p);
    expect(folded).toEqual([]);
    expect((await p.stageRuns(id)).filter((r) => r.stage === "implementing")[0]).toMatchObject({ status: "passed" });
  });

  it("runs the same with no economy at all", async () => {
    const p = new Pipeline(db, (stage) => (stage === "implementing" ? async () => ({ outcome: "pass" as const }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const id = await approvedCard(p);
    expect((await p.stageRuns(id)).filter((r) => r.stage === "implementing")[0]).toMatchObject({ status: "passed" });
  });

  it("escalates a run the loop guard stopped, with no retry, and tells the decision what stopped it", async () => {
    const asked: Array<[string, Record<string, any>]> = [];
    const ran: number[] = [];
    const p = build(noEconomy(), async () => (ran.push(1), stuck), async (pack: string, check: Record<string, any>) => (asked.push([pack, check]), { reason: { choice: "flaky_tests", confidence: 0.9 } }));
    const id = await approvedCard(p);
    expect(ran).toHaveLength(1);
    expect((await p.get(id)).state).toBe("escalated");
    expect((await p.get(id)).reason).toContain(LOOP_STUCK);
    expect(asked[0]![0]).toBe("escalation_reason");
    expect(asked[0]![1].escalation.facts).toContain("the loop guard stopped the run: the same test fails after each edit after 31 calls");
  });

  it("tells the economy each card that closes, with its repository's config and the proposer; with no proposer it tells nothing", async () => {
    const closed: unknown[][] = [];
    const economy: Economy = { ...noEconomy(), cardClosed: async (...a) => void closed.push(a) };
    const propose = async () => null;
    const run = async (proposer?: { run: typeof propose | null }) => {
      const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, economy, ...(proposer ? { proposer } : {}) });
      const task = await p.createTask({ title: "Login page", criteria: ["x"], repoPath: "/r/a" });
      await p.start(task.id);
      for (let i = 0; i < 2; i++) await p.decide(task.id, "approved");
      expect((await p.get(task.id)).state).toBe("closed");
      return task.id;
    };
    const id = await run({ run: propose });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject(["/r/a", id, { facts: expect.any(String), propose_every: expect.any(Number) }, propose]);
    await run();
    await run({ run: null });
    expect(closed).toHaveLength(1);
  });

  it("does not wait for the proposer when a card closes: the next held card is released first, and the tick finishes on its own", async () => {
    let finish: () => void = () => {};
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const started: string[] = [];
    const economy: Economy = { ...noEconomy(), cardClosed: async (_r, id) => (started.push(id), void (await slow)) };
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, economy, proposer: { run: async () => null } });
    const task = await p.createTask({ title: "Login page", criteria: ["x"], repoPath: "/r/a" });
    await p.start(task.id);
    for (let i = 0; i < 2; i++) await p.decide(task.id, "approved");
    expect((await p.get(task.id)).state).toBe("closed");
    expect(started).toEqual([task.id]);
    finish();
    await p.factTicksDone();
  });

  it("marks the facts the approved retro wrote as pending, not promoted, once the rules step wrote them, and not when the rules were skipped", async () => {
    const promoted: unknown[][] = [];
    const pending: unknown[][] = [];
    const economy: Economy = { ...noEconomy(), promoted: async (...a) => (promoted.push(a), a[1].length), pending: async (...a) => (pending.push(a), a[1].length) };
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const run = async (applyRules: boolean) => {
      const worktree = await mkdtemp(join(tmpdir(), "promoted-"));
      const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, economy, closeDeps: { exec: async (_c, args) => (args.includes("rev-parse") ? { code: 128, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" }), worktreeRemove: false } });
      stubs.plan("reviewing_memory", { outcome: "pass", detail: { rules: { markdown: "", factPromotions: [{ id: "aaaaaaaaaaaa", text: "Run the tests with `python -m pytest -q`.", section: "Commands" }] } } });
      const task = await p.createTask({ title: "Login page", criteria: ["x"], repoPath: "/r/a" });
      await p.start(task.id);
      for (let i = 0; i < 2; i++) await p.decide(task.id, "approved");
      await (p as unknown as { store: { updateTask: (id: string, patch: object) => Promise<void> } }).store.updateTask(task.id, { worktreePath: worktree });
      await p.decide(task.id, "approved", undefined, { applyRules });
    };
    await run(false);
    expect(pending).toEqual([]);
    await run(true);
    expect(promoted).toEqual([]);
    expect(pending).toEqual([["/r/a", ["aaaaaaaaaaaa"], expect.any(String)]]);
  });

  it("escalates a stopped run on a stage that is not Build too", async () => {
    const p = new Pipeline(db, (stage) => (stage === "verifying" ? async () => stuck : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const id = await approvedCard(p);
    expect((await p.get(id)).state).toBe("escalated");
    expect((await p.get(id)).reason).toContain(LOOP_STUCK);
  });
});

describe("restart recovery", () => {
  it("re-arms the resume timer of a task paused on a usage limit", async () => {
    vi.useFakeTimers();
    try {
      const inOneHour = Math.floor(Date.now() / 1000) + 3600;
      stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: String(inOneHour) } });
      const task = await newTask();
      expect((await startAndApprove(task.id)).state).toBe("paused_rate_limit");

      // A new machine over the same database: no timers survive in memory.
      const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
      expect(restarted.hasResumeTimer(task.id)).toBe(false);
      await restarted.recover();
      expect(restarted.hasResumeTimer(task.id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes at once a paused task whose window already reset while the machine was down", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: past } });
    const task = await newTask();
    expect((await startAndApprove(task.id)).state).toBe("paused_rate_limit");

    const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    await restarted.recover();
    // inline: the resumed implementing run (now a plain pass) drives on to the ship gate.
    expect((await restarted.get(task.id)).state).toBe("awaiting_ship");
  });

  it("escalates a task whose stage loop crashed, with the error as the reason, instead of leaving it running", async () => {
    const task = await newTask();
    // Fail the stage_done transition inside the loop (not the start dispatch): the shape of
    // a DB hiccup while a stage was running.
    const target = pipeline as unknown as { apply: (...a: unknown[]) => Promise<unknown> };
    const original = target.apply.bind(pipeline);
    let tripped = false;
    vi.spyOn(target, "apply").mockImplementation(async (...args: unknown[]) => {
      if (!tripped && (args[1] as { type: string }).type === "stage_done") {
        tripped = true;
        throw new Error("db down");
      }
      return original(...args);
    });
    await pipeline.start(task.id);
    const after = await pipeline.get(task.id);
    expect(after).toMatchObject({ state: "escalated", reason: "stage loop crashed: db down", resumeTo: "triage" });
  });
});

describe("the supervisor tick", () => {
  /** What a lost wakeup leaves behind: a task queued for a slot while no loop is finishing. */
  const parkQueued = (id: string, state: TaskState) =>
    db.query("update tasks set state = $2, queued = true, updated_at = now() - interval '5 minutes' where id = $1", [id, state]);

  it("fills a free slot the queue was waiting on", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    await parkQueued(task.id, "triage");
    await pipeline.tick();
    expect(await pipeline.get(task.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  });

  it("escalates a running task no loop is driving, once it has sat there past the grace period", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    await db.query("update tasks set state = 'implementing', queued = false, updated_at = now() - interval '5 minutes' where id = $1", [task.id]);
    const fresh = await pipeline.createTask({ title: "Just transitioned" });
    await db.query("update tasks set state = 'implementing', queued = false where id = $1", [fresh.id]);

    await pipeline.tick();

    expect(await pipeline.get(task.id)).toMatchObject({
      state: "escalated",
      reason: "stage loop crashed: no stage loop was driving it",
      resumeTo: "implementing",
    });
    // Inside the grace period it may be a task between its transition and its slot: left alone.
    expect((await pipeline.get(fresh.id)).state).toBe("implementing");
  });

  it("leaves a task whose loop is alive untouched", async () => {
    let finish: (() => void) | undefined;
    const blocking: StageRunner = () => new Promise<StageResult>((resolve) => (finish = () => resolve({ outcome: "pass" })));
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? blocking : stubs.runnerFor(stage)));
    const task = await newTask();
    await pipeline.start(task.id);
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
    await db.query("update tasks set updated_at = now() - interval '5 minutes' where id = $1", [task.id]);

    await pipeline.tick();
    expect((await pipeline.get(task.id)).state).toBe("triage");

    finish();
    while ((await pipeline.get(task.id)).state === "triage") await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("re-arms the resume timer of a paused task that lost it", async () => {
    vi.useFakeTimers();
    try {
      const inOneHour = Math.floor(Date.now() / 1000) + 3600;
      stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: String(inOneHour) } });
      const task = await newTask();
      expect((await startAndApprove(task.id)).state).toBe("paused_rate_limit");

      const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
      await restarted.tick();
      expect(restarted.hasResumeTimer(task.id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims nothing while a usage window is latched, then drains the queue once it resets", async () => {
    vi.useFakeTimers();
    try {
      const inOneHour = Math.floor(Date.now() / 1000) + 3600;
      stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: String(inOneHour) } });
      const paused = await newTask();
      expect((await startAndApprove(paused.id)).state).toBe("paused_rate_limit");
      expect(pipeline.latchedUntil).not.toBeNull();

      // Another task asking for a slot during the window queues instead of hitting the same wall.
      const waiting = await pipeline.createTask({ title: "Second" });
      expect(await pipeline.start(waiting.id)).toMatchObject({ state: "triage", queued: true });
      await pipeline.tick();
      expect(await pipeline.get(waiting.id)).toMatchObject({ state: "triage", queued: true });

      vi.setSystemTime(Date.now() + 3600 * 1000 + 60_000);
      await pipeline.tick();
      expect(await pipeline.get(waiting.id)).toMatchObject({ state: "awaiting_approval", queued: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stage's notes", () => {
  it("logs a note a runner gives while it runs on the task's activity, against the run", async () => {
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? async ({ note }) => {
      await note?.("waiting for the Codex login");
      return { outcome: "pass" };
    } : stubs.runnerFor(stage)), { inline: true, hasConfig: () => true });
    const task = await newTask();
    await pipeline.start(task.id);
    const [run] = await pipeline.stageRuns(task.id);
    const noted = (await pipeline.events(task.id)).find((e) => e.kind === "stage.note");
    expect(noted).toMatchObject({ stageRunId: run!.id, payload: { stage: "triage", note: "waiting for the Codex login" } });
  });
});

describe("one usage window per credential", () => {
  const everyCredential = { check: async () => ({ available: true as const }) };
  const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
  /** Triage hits the usage window of the engine named for the task, once, and of any engine it
   *  falls back to; any other run passes. */
  const limitedTriage = (limited: Map<string, EngineId>) => (stage: TaskState): StageRunner =>
    stage !== "triage"
      ? stubs.runnerFor(stage)
      : async ({ task, engine: fallback, started }) => {
          const engine = fallback ?? limited.get(task.id);
          if (!engine) return { outcome: "pass" };
          limited.delete(task.id);
          await started?.({ container: `c-${task.id.slice(0, 8)}`, inputCommit: null, engine });
          return { outcome: "fail", rateLimited: true, detail: { resetsAt: inOneHour() } };
        };
  /** Every credential but the one triage would fall back to from Codex: the latch is all there is. */
  const noClaudeFallback = { check: async (engine: EngineId) => (engine === "claude:opus" ? { available: false as const, reason: "unset" } : { available: true as const }) };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 400 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  it("a Codex window holds only the tasks whose next stage runs on Codex; Claude work keeps claiming", async () => {
    const limited = new Map<string, EngineId>();
    pipeline = new Pipeline(db, limitedTriage(limited), { inline: true, policies: previewOn, hasConfig: () => true, credentials: noClaudeFallback });
    const onCodex = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    limited.set(onCodex.id, "codex:sol");
    expect((await pipeline.start(onCodex.id)).state).toBe("paused_rate_limit");
    expect(pipeline.slots.latched).toEqual([{ owner: "codex", until: expect.any(String) }]);
    expect((await pipeline.events(onCodex.id)).find((e) => e.kind === "usage.latched")?.payload).toMatchObject({ owner: "codex", engine: "codex:sol" });

    // A Claude task starts at once; another Codex one waits in the queue.
    const claude = await newTask();
    expect((await pipeline.start(claude.id)).state).toBe("awaiting_approval");
    const codex = await pipeline.createTask({ title: "also codex", stages: { triage: "codex:sol" } });
    expect(await pipeline.start(codex.id)).toMatchObject({ state: "triage", queued: true });

    // The claim skips the held task and takes the Claude one queued behind it.
    pipeline.drain();
    const queuedClaude = await newTask();
    expect(await pipeline.start(queuedClaude.id)).toMatchObject({ state: "triage", queued: true });
    pipeline.resumeClaims();
    await until(async () => (await pipeline.get(queuedClaude.id)).state === "awaiting_approval");
    expect(await pipeline.get(queuedClaude.id)).toMatchObject({ state: "awaiting_approval", queued: false });
    await pipeline.tick();
    expect(await pipeline.get(codex.id)).toMatchObject({ state: "triage", queued: true });

    // Resuming the Codex task opens Codex's window again, and the queue drains.
    expect((await pipeline.windowReset(onCodex.id)).state).toBe("awaiting_approval");
    expect(pipeline.slots.latched).toEqual([]);
    await pipeline.tick();
    expect(await pipeline.get(codex.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  });

  it("a Claude window does not hold a task whose next stage runs on codex:sol", async () => {
    const limited = new Map<string, EngineId>();
    // No Codex login while the Claude task runs, so it pauses rather than falling back; then there is one.
    let codexLogin = false;
    const credentials = { check: async (engine: EngineId) => (engine.startsWith("codex") && !codexLogin ? { available: false as const, reason: "unset" } : { available: true as const }) };
    pipeline = new Pipeline(db, limitedTriage(limited), { inline: true, policies: previewOn, hasConfig: () => true, credentials });
    const claude = await newTask();
    limited.set(claude.id, "claude:opus");
    expect((await pipeline.start(claude.id)).state).toBe("paused_rate_limit");
    expect(pipeline.slots.latched).toEqual([{ owner: "claude", until: expect.any(String) }]);
    codexLogin = true;

    const codex = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    expect((await pipeline.start(codex.id)).state).toBe("awaiting_approval");
    const other = await newTask();
    expect(await pipeline.start(other.id)).toMatchObject({ state: "triage", queued: true });
  });

  it("a restart keeps each credential's window, and a pick that falls back to Claude waits with Claude", async () => {
    const limited = new Map<string, EngineId>();
    pipeline = new Pipeline(db, limitedTriage(limited), { inline: true, policies: previewOn, hasConfig: () => true, credentials: everyCredential });
    const claude = await newTask();
    limited.set(claude.id, "claude:opus");
    const codex = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    limited.set(codex.id, "codex:sol");
    // The Claude task hits Claude's window, falls back to Codex and hits that one too; the Codex task then waits.
    expect((await pipeline.start(claude.id)).state).toBe("paused_rate_limit");
    expect(await pipeline.start(codex.id)).toMatchObject({ state: "triage", queued: true });
    await pipeline.shutdown();

    // This machine has no Codex login: a task asking for codex:sol runs triage on claude:opus.
    const noCodex = { check: async (engine: EngineId) => (engine.startsWith("codex") ? { available: false as const, reason: "no Codex login" } : { available: true as const }) };
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, credentials: noCodex });
    await pipeline.recover();
    expect(pipeline.slots.latched.map((latch) => latch.owner).sort()).toEqual(["claude", "codex"]);
    const fallsBack = await pipeline.createTask({ title: "asks for codex", stages: { triage: "codex:sol" } });
    expect(await pipeline.start(fallsBack.id)).toMatchObject({ state: "triage", queued: true });
    await pipeline.tick();
    expect(await pipeline.get(fallsBack.id)).toMatchObject({ state: "triage", queued: true });
  });
});

describe("awaiting_ship holds a stage or a gate", () => {
  const park = (id: string, state: TaskState) => db.query("update tasks set state = $2, queued = false, updated_at = now() - interval '5 minutes' where id = $1", [id, state]);

  it("writes gate: true on the transition row that opens a gate, and only then", async () => {
    const task = await newTask();
    await startAndApprove(task.id);
    const rows = (await pipeline.events(task.id)).filter((e) => e.kind === "transition");
    const opened = rows.find((e) => e.payload.to === "awaiting_ship");
    expect(opened?.payload.gate).toBe(true);
    expect(rows.filter((e) => e.payload.gate === true).map((e) => e.payload.to)).toEqual(expect.arrayContaining(["awaiting_approval", "awaiting_ship"]));
    expect(rows.find((e) => e.payload.to === "implementing")?.payload.gate).toBeUndefined();
  });

  it("tick escalates a card at awaiting_ship with no open approval and no loop, as a stuck running card", async () => {
    const task = await pipeline.createTask({ title: "watched" });
    await park(task.id, "awaiting_ship");
    await pipeline.tick();
    expect(await pipeline.get(task.id)).toMatchObject({ state: "escalated", resumeTo: "awaiting_ship" });
  });

  it("tick leaves a card at awaiting_ship with an open approval alone", async () => {
    const task = await newTask();
    await startAndApprove(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
    await db.query("update tasks set updated_at = now() - interval '5 minutes' where id = $1", [task.id]);
    await pipeline.tick();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
  });

  it("recover runs the watch again for a card at awaiting_ship with no approval, as a host poller", async () => {
    const task = await pipeline.createTask({ title: "watched" });
    await park(task.id, "awaiting_ship");
    const seen: TaskState[] = [];
    pipeline = new Pipeline(db, (stage) => (stage === "awaiting_ship" ? async () => (seen.push(stage), { outcome: "pass" as const }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    expect(await pipeline.recover()).toBe(0);
    expect(seen).toEqual(["awaiting_ship"]);
    expect((await pipeline.events(task.id)).some((e) => e.kind === "stage.restarted" && e.payload.stage === "awaiting_ship")).toBe(true);
    expect((await pipeline.get(task.id)).state).toBe("closed");
  });

  it("approving the preview gate starts the watch; the ship approval's own approval starts the merge", async () => {
    const task = await newTask();
    await startAndApprove(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
    const before = (await stagesRun(task.id)).filter((s) => s === "awaiting_ship").length;
    await pipeline.decide(task.id, "approved");
    const ran = await stagesRun(task.id);
    expect(ran.filter((s) => s === "awaiting_ship").length).toBe(before + 1);
    expect(ran.slice(-2)).toEqual(["shipping", "reviewing_memory"]);
    expect((await pipeline.get(task.id)).state).toBe("closed");

    const second = await newTask();
    stubs.plan("awaiting_ship", { outcome: "needs_input", detail: { gate: "ship_approval", head: "abc" } });
    await startAndApprove(second.id);
    await pipeline.decide(second.id, "approved");
    // The preview gate approved, then the watch asked the release question: it waits with its own approval.
    expect((await pipeline.get(second.id)).state).toBe("awaiting_ship");
    const open = (await pipeline.approvals(second.id)).find((a) => a.decision === null);
    expect(open?.requested.gate).toBe("ship_approval");
    await pipeline.decide(second.id, "approved");
    expect((await stagesRun(second.id)).slice(-2)).toEqual(["shipping", "reviewing_memory"]);
    expect((await pipeline.get(second.id)).state).toBe("closed");
  });

  it("a shipping run that is not ready hands the card back to the watch; media refresh and the escalation head_moved run e2e", async () => {
    const task = await newTask();
    stubs.plan("shipping", { outcome: "fail", detail: { notReady: true, reason: "CI is red" } });
    await startAndApprove(task.id);
    await pipeline.decide(task.id, "approved");
    const ran = await stagesRun(task.id);
    expect(ran.slice(-4)).toEqual(["shipping", "awaiting_ship", "shipping", "reviewing_memory"]);
    expect((await pipeline.get(task.id)).state).toBe("closed");

    const refresh = await newTask();
    stubs.plan("awaiting_ship", { outcome: "escalated", detail: { escalation: "head_moved", refresh: "media", reason: "a fix changed a scenario" } });
    await startAndApprove(refresh.id);
    await pipeline.decide(refresh.id, "approved");
    expect((await stagesRun(refresh.id)).filter((st) => st === "e2e")).toHaveLength(2);
  });

  it("abort at awaiting_ship with an open approval is still refused", async () => {
    const task = await newTask();
    await startAndApprove(task.id);
    await expect(pipeline.abort(task.id)).rejects.toThrow();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
  });
});

describe("fallback across engines", () => {
  const everyCredential = { check: async () => ({ available: true as const }) };
  const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
  /** Triage on the engines in `limited` hits their usage window; on any other it passes. The engine
   *  is the fallback the machine hands it, else the task's own pick, else the pack's default. */
  const triageLimitedOn = (limited: Set<EngineId>, ran: EngineId[] = []) => (stage: TaskState): StageRunner =>
    stage !== "triage"
      ? stubs.runnerFor(stage)
      : async ({ task, engine: fallback, started }) => {
          const engine = fallback ?? task.stages?.triage ?? "claude:opus";
          ran.push(engine);
          await started?.({ container: `c-${task.id.slice(0, 8)}`, inputCommit: null, engine });
          return limited.has(engine) ? { outcome: "fail", rateLimited: true, detail: { resetsAt: inOneHour() } } : { outcome: "pass", detail: { brief: "ok" } };
        };

  it("runs triage again on claude:opus when Codex hits its usage limit, and says which engine answered", async () => {
    const ran: EngineId[] = [];
    pipeline = new Pipeline(db, triageLimitedOn(new Set(["codex:sol"]), ran), { inline: true, policies: previewOn, hasConfig: () => true, credentials: everyCredential });
    const task = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    expect((await pipeline.start(task.id)).state).toBe("awaiting_approval");
    expect(ran).toEqual(["codex:sol", "claude:opus"]);

    const runs = await pipeline.stageRuns(task.id);
    expect(runs.slice(0, 2).map((r) => [r.stage, r.engine, r.status, r.outcome])).toEqual([
      ["triage", "codex:sol", "paused", "rate_limited"],
      ["triage", "claude:opus", "passed", "pass"],
    ]);
    const events = await pipeline.events(task.id);
    expect(events.find((e) => e.kind === "stage.engine")).toMatchObject({ stageRunId: runs[1]!.id, payload: { stage: "triage", engine: "claude:opus", reason: "fallback after codex:sol rate limit" } });
    expect(events.find((e) => e.kind === "usage.latched")?.payload).toMatchObject({ owner: "codex", engine: "codex:sol" });
    expect(events.some((e) => e.kind === "transition" && e.payload.to === "paused_rate_limit")).toBe(false);
    // Codex's window is still held for the rest of the queue.
    expect(pipeline.slots.latched).toEqual([{ owner: "codex", until: expect.any(String) }]);
  });

  it("pauses once every fallback has hit its limit too", async () => {
    const ran: EngineId[] = [];
    pipeline = new Pipeline(db, triageLimitedOn(new Set(["codex:sol", "claude:opus"]), ran), { inline: true, policies: previewOn, hasConfig: () => true, credentials: everyCredential });
    const task = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    expect((await pipeline.start(task.id)).state).toBe("paused_rate_limit");
    expect(ran).toEqual(["codex:sol", "claude:opus"]);
    expect(pipeline.slots.latched.map((latch) => latch.owner).sort()).toEqual(["claude", "codex"]);
  });

  it("does not fall back to an engine whose window is already held", async () => {
    const ran: EngineId[] = [];
    // No Codex login while a Claude task hits Claude's limit, so it pauses and holds Claude's window.
    let codexLogin = false;
    const credentials = { check: async (engine: EngineId) => (engine.startsWith("codex") && !codexLogin ? { available: false as const, reason: "unset" } : { available: true as const }) };
    pipeline = new Pipeline(db, triageLimitedOn(new Set(["claude:opus", "codex:sol"]), ran), { inline: true, policies: previewOn, hasConfig: () => true, credentials });
    const first = await newTask();
    expect((await pipeline.start(first.id)).state).toBe("paused_rate_limit");
    expect(pipeline.slots.latched.map((latch) => latch.owner)).toEqual(["claude"]);

    // A Codex task hits Codex's limit: Claude's window is held, so it pauses with no run on claude:opus.
    codexLogin = true;
    ran.length = 0;
    const second = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    expect((await pipeline.start(second.id)).state).toBe("paused_rate_limit");
    expect(ran).toEqual(["codex:sol"]);
  });

  it("skips a fallback whose credential this machine lacks, and pauses", async () => {
    const ran: EngineId[] = [];
    const noClaude = { check: async (engine: EngineId) => (engine.startsWith("claude") ? { available: false as const, reason: "no Claude credential" } : { available: true as const }) };
    pipeline = new Pipeline(db, triageLimitedOn(new Set(["codex:sol"]), ran), { inline: true, policies: previewOn, hasConfig: () => true, credentials: noClaude });
    const task = await pipeline.createTask({ title: "on codex", stages: { triage: "codex:sol" } });
    expect((await pipeline.start(task.id)).state).toBe("paused_rate_limit");
    expect(ran).toEqual(["codex:sol"]);
    expect((await pipeline.events(task.id)).some((e) => e.kind === "stage.engine")).toBe(false);
  });

  it("asks about each fallback for the task's repo, so a monthly cap there holds it back and the task pauses", async () => {
    const ran: EngineId[] = [];
    const asked: Array<[EngineId, string | null | undefined]> = [];
    const capped = {
      check: async (engine: EngineId, scope?: { repo?: string | null }) => {
        asked.push([engine, scope?.repo]);
        return engine === "codex:sol" ? { available: false as const, code: "budget" as const, reason: "over its monthly budget ($5.00 of $5.00 on codex in a)" } : { available: true as const };
      },
    };
    pipeline = new Pipeline(db, triageLimitedOn(new Set(["claude:opus"]), ran), { inline: true, policies: previewOn, hasConfig: () => true, credentials: capped });
    const task = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    expect((await pipeline.start(task.id)).state).toBe("paused_rate_limit");
    expect(ran).toEqual(["claude:opus"]);
    expect(asked).toContainEqual(["codex:sol", "/r/a"]);
  });

  it("never falls back on a stage whose pack has no fallback", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, credentials: everyCredential });
    stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: String(inOneHour()) } });
    const task = await newTask();
    expect((await startAndApprove(task.id)).state).toBe("paused_rate_limit");
    expect((await stagesRun(task.id)).filter((stage) => stage === "implementing")).toHaveLength(1);
  });
});

describe("budgets", () => {
  const costly = (costUsd: number): StageResult => ({ outcome: "pass", usage: { turns: 1, costUsd } });
  const backdateRuns = (taskId: string) =>
    db.query("update stage_runs set started_at = now() - interval '25 hours' where task_id = $1", [taskId]);

  it("tells the engine caps about a run with a cost, naming the engine it ran on, the task and its repo", async () => {
    const runs: Array<[EngineId, { taskId: string | null; repo: string | null }]> = [];
    const engineBudgets = { afterRun: async (engine: EngineId, run: { taskId: string | null; repo: string | null }) => void runs.push([engine, run]) };
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? async ({ started }) => {
      await started?.({ container: "c", inputCommit: null, engine: "codex:sol" });
      return costly(0.5);
    } : stubs.runnerFor(stage)), { inline: true, hasConfig: () => true, engineBudgets });
    const task = await pipeline.createTask({ title: "a", repoPath: "/r/a", stages: { triage: "codex:sol" } });
    await pipeline.start(task.id);
    expect(runs).toEqual([["codex:sol", { taskId: task.id, repo: "/r/a" }]]);
  });

  it("escalates a task that spent past its own ceiling before its next stage runs", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, budget: { taskUsd: 2 } });
    stubs.plan("triage", costly(3));
    const task = await newTask();

    const held = await pipeline.start(task.id);
    expect(held).toMatchObject({ state: "escalated", reason: "budget: task spent $3.00 of $2.00", resumeTo: "test_design" });
    expect(await stagesRun(task.id)).toEqual(["triage"]);
  });

  it("holds the queue while the day's spend is over the ceiling, and drains it once it is not", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, budget: { dailyUsd: 2 } });
    stubs.plan("triage", costly(3));
    const a = await newTask();
    // a's triage spent the day's ceiling, so its plan stage is parked before it runs.
    expect(await pipeline.start(a.id)).toMatchObject({ state: "test_design", queued: true });

    const b = await newTask();
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: true });
    await pipeline.tick();
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });
    expect(await stagesRun(b.id)).toEqual([]);

    await backdateRuns(a.id);
    await pipeline.tick();
    expect(await pipeline.get(b.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  });

  it("parks a running task between stages once the day's ceiling is reached, instead of escalating it", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, budget: { dailyUsd: 2 } });
    stubs.plan("triage", costly(3));
    const task = await newTask();

    expect(await pipeline.start(task.id)).toMatchObject({ state: "test_design", queued: true });
    expect(await stagesRun(task.id)).toEqual(["triage"]);
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("budget.held");

    await backdateRuns(task.id);
    await pipeline.tick();
    expect(await pipeline.get(task.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  });
});

describe("a repo's monthly budget and the alerts", () => {
  const costly = (costUsd: number): StageResult => ({ outcome: "pass", usage: { turns: 1, costUsd } });
  const policies = (monthly: Record<string, number | null>) => ({
    for: async (repoPath: string | null) => ({ ...DEFAULT_POLICY, monthlyBudgetUsd: repoPath ? (monthly[repoPath] ?? null) : null }),
  });

  it("parks a task between stages once its repo spent its month, and the queue skips that repo", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: policies({ "/r/a": 2 }) });
    stubs.plan("triage", costly(3));
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    expect(await pipeline.start(a.id)).toMatchObject({ state: "test_design", queued: true });
    const held = (await pipeline.events(a.id)).find((e) => e.kind === "budget.held");
    expect(held?.payload.reason).toBe("budget: /r/a spent $3.00 of $2.00 this month");

    // Another task of the same repo waits in the queue; one of another repo goes.
    const a2 = await pipeline.createTask({ title: "a2", repoPath: "/r/a" });
    expect(await pipeline.start(a2.id)).toMatchObject({ state: "triage", queued: true });
    const b = await pipeline.createTask({ title: "b", repoPath: "/r/b" });
    expect((await pipeline.start(b.id)).state).toBe("awaiting_approval");
    await pipeline.tick();
    expect(await pipeline.get(a.id)).toMatchObject({ state: "test_design", queued: true });
    expect(await pipeline.get(a2.id)).toMatchObject({ state: "triage", queued: true });

    // Last month's spend does not count.
    await db.query("update stage_runs set started_at = date_trunc('month', now()) - interval '1 day'");
    await pipeline.tick();
    expect(await pipeline.get(a.id)).toMatchObject({ state: "awaiting_approval", queued: false });
    expect(await pipeline.get(a2.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  });

  it("raises each threshold once per scope: task, repo-month and day", async () => {
    const alerts: BudgetAlert[] = [];
    pipeline = new Pipeline(db, stubs.runnerFor, {
      inline: true, hasConfig: () => true,
      budget: { taskUsd: 10, dailyUsd: 100 },
      policies: policies({ "/r/a": 10 }),
      onAlert: (alert) => alerts.push(alert),
    });
    stubs.plan("triage", costly(8.5), costly(8.5));
    stubs.plan("test_design", costly(0.6));
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    // Triage spends 8.5 (80% of both ceilings), then the plan stage 0.6 (90%): one start, both lines.
    await pipeline.start(a.id);
    expect(alerts).toEqual([
      { scope: "task", taskId: a.id, repo: "/r/a", pct: 80, spentUsd: 8.5, limitUsd: 10 },
      { scope: "repo", taskId: a.id, repo: "/r/a", pct: 80, spentUsd: 8.5, limitUsd: 10 },
      { scope: "task", taskId: a.id, repo: "/r/a", pct: 90, spentUsd: 9.1, limitUsd: 10 },
      { scope: "repo", taskId: a.id, repo: "/r/a", pct: 90, spentUsd: 9.1, limitUsd: 10 },
    ]);
    const a2 = await pipeline.createTask({ title: "a2", repoPath: "/r/a" });
    expect(alerts).toHaveLength(4);
    await pipeline.start(a2.id);
    expect(alerts.slice(4)).toEqual([
      { scope: "task", taskId: a2.id, repo: "/r/a", pct: 80, spentUsd: 8.5, limitUsd: 10 },
      { scope: "repo", taskId: a2.id, repo: "/r/a", pct: 100, spentUsd: 17.6, limitUsd: 10 },
    ]);
    // The day's ceiling, far away, never fires; a repeat run past a line already raised stays quiet.
    expect(alerts.some((a) => a.scope === "day")).toBe(false);
  });
});

describe("timer-approved plans", () => {
  const policies = (minutes: number | null) => ({ for: async () => ({ ...PREVIEW_ON, autoApprovePlanMinutes: minutes }) });
  const confident = (over: Record<string, unknown> = {}): StageResult => ({
    outcome: "pass",
    detail: { brief: "b", risk: { level: "low", scores: {} }, verdicts: { coverage: "proceed", plan: "proceed", risk: "proceed" }, ...over },
  });

  it("approves a confident, low-risk plan by itself once the policy's minutes have passed", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: policies(10) });
    stubs.plan("test_design", confident());
    const task = await pipeline.createTask({ title: "t", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.tick();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");

    await db.query("update approvals set created_at = now() - interval '11 minutes'");
    await pipeline.tick();
    // The stubs carry it through to the shipping gate.
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
    expect((await pipeline.approvals(task.id))[0]).toMatchObject({
      decision: "approved",
      reason: "auto-approved after 10 min: low risk and every check proceeded",
    });
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("plan.auto_approved");
  });

  it("never approves a re-planned gate or a gate with any flag, however confident its verdicts", async () => {
    for (const over of [{ replan: { raised_by: "verifying", reason: "wrong" } }, { flagged: ["plan outside map"] }, { flagged: ["map stale"], replan: undefined }]) {
      stubs.reset();
      pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: policies(10) });
      stubs.plan("test_design", confident(over));
      const task = await pipeline.createTask({ title: "t", repoPath: "/r/a" });
      await pipeline.start(task.id);
      await db.query("update approvals set created_at = now() - interval '11 minutes'");
      await pipeline.tick();
      expect((await pipeline.get(task.id)).state, JSON.stringify(over)).toBe("awaiting_approval");
      expect((await pipeline.events(task.id)).map((e) => e.kind)).not.toContain("plan.auto_approved");
    }
  });

  it("never approves a reply or an archive gate, whatever else it carries", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: policies(10) });
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "conversation", reply: "Use pnpm dev.", record: { goal: "g", reason: "r" }, risk: { level: "low", scores: {} }, verdicts: { coverage: "proceed", plan: "proceed", risk: "proceed" } } });
    const task = await pipeline.createTask({ title: "t", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await db.query("update approvals set created_at = now() - interval '11 minutes'");
    await pipeline.tick();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");
    expect((await pipeline.events(task.id)).map((e) => e.kind)).not.toContain("plan.auto_approved");
    expect((await pipeline.events(task.id)).map((e) => e.kind)).not.toContain("task.reply");
  });

  it("never approves a Luna Notch task's plan: the notch's own AutoApproval decides (RFC 0004)", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: policies(10) });
    stubs.plan("test_design", confident(), confident());
    const source = { kind: "notch", ref: "LUNA-14", id: "8f1c0d7e-0000-0000-0000-000000000000" } as const;
    const notch = await pipeline.createTask({ title: "n", repoPath: "/r/a", source });
    const tui = await pipeline.createTask({ title: "t", repoPath: "/r/a" });
    await pipeline.start(notch.id);
    await pipeline.start(tui.id);
    await db.query("update approvals set created_at = now() - interval '11 minutes'");
    await pipeline.tick();
    expect((await pipeline.get(notch.id)).state).toBe("awaiting_approval");
    expect((await pipeline.events(notch.id)).map((e) => e.kind)).not.toContain("plan.auto_approved");
    expect((await pipeline.get(tui.id)).state).toBe("awaiting_ship");
  });

  it("keeps waiting when a check did not proceed, risk is not low, the plan stage asked questions, or the policy is off", async () => {
    const cases: Array<[number | null, StageResult]> = [
      [10, confident({ verdicts: { coverage: "proceed", plan: "flag", risk: "proceed" } })],
      [10, confident({ verdicts: { coverage: "proceed", plan: "proceed", risk: "skipped" } })],
      [10, confident({ risk: { level: "medium", scores: {} } })],
      [10, confident({ risk: undefined })],
      [10, { outcome: "needs_input", needsInput: [{ question: "q", recommended: "r" }], detail: { risk: { level: "low", scores: {} } } }],
      [null, confident()],
    ];
    for (const [minutes, result] of cases) {
      await db.query("truncate tasks cascade");
      pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, policies: policies(minutes) });
      stubs.plan("test_design", result);
      const task = await pipeline.createTask({ title: "t", repoPath: "/r/a" });
      const started = await pipeline.start(task.id);
      await db.query("update approvals set created_at = now() - interval '11 minutes'");
      await pipeline.tick();
      expect((await pipeline.get(task.id)).state).toBe(started.state);
    }
  });
});

describe("aborting a running stage", () => {
  it("returns once the stage loop has wound down, so a retry or a delete never races the dying container", async () => {
    // A stage that, told to stop, takes a moment to die and clean up, the way a container does.
    let released = false;
    const slowToDie: StageRunner = ({ signal }) =>
      new Promise<StageResult>((resolve) =>
        signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => {
              released = true;
              resolve({ outcome: "fail" });
            }, 30),
          { once: true },
        ),
      );
    let reached = 0;
    const runnerFor = (stage: TaskState) =>
      stage === "triage"
        ? (context: Parameters<StageRunner>[0]) => {
            reached++;
            return slowToDie(context);
          }
        : stubs.runnerFor(stage);
    pipeline = new Pipeline(db, runnerFor);
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    const aborted = await pipeline.abort(a.id);

    expect(aborted).toMatchObject({ state: "escalated", reason: "aborted" });
    expect(released).toBe(true);
    expect((await pipeline.stageRuns(a.id)).at(-1)).toMatchObject({ stage: "triage", status: "aborted" });
  });
});

describe("archiving a running stage", () => {
  it("stops the stage and waits for its container to let go before the close step removes the worktree", async () => {
    let released = false;
    const slowToDie: StageRunner = ({ signal }) =>
      new Promise<StageResult>((resolve) =>
        signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => {
              released = true;
              resolve({ outcome: "fail" });
            }, 30),
          { once: true },
        ),
      );
    let reached = 0;
    const runnerFor = (stage: TaskState) =>
      stage === "triage"
        ? (context: Parameters<StageRunner>[0]) => {
            reached++;
            return slowToDie(context);
          }
        : stubs.runnerFor(stage);
    /** Whether the container had let go each time the close step removed a worktree. */
    const removals: boolean[] = [];
    const exec = async (command: string, args: string[]) => {
      if (command === "git" && args.includes("worktree")) removals.push(released);
      return { code: 0, stdout: "", stderr: "" };
    };
    pipeline = new Pipeline(db, runnerFor, { closeDeps: { exec, worktreeRemove: true } });
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await db.query('update tasks set repo_path = $1, worktree_path = $2 where id = $3', ["/r/a", "/r/a/.orc/wt", a.id]);

    const archived = await pipeline.archive(a.id, "rejected");

    expect(archived).toMatchObject({ state: "archived", archiveReason: "rejected", worktreePath: null });
    expect(released).toBe(true);
    expect(removals).toEqual([true]);
    expect((await pipeline.stageRuns(a.id)).at(-1)).toMatchObject({ stage: "triage", status: "aborted" });
  });

  it("archives only from the states the caller names, checked under the row lock", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const a = await newTask();
    await expect(pipeline.archive(a.id, "sla_expired", { onlyFrom: new Set<TaskState>(["awaiting_answers"]) })).rejects.toThrow(TaskMovedError);
    expect((await pipeline.get(a.id)).state).toBe("draft");
    const archived = await pipeline.archive(a.id, "sla_expired", { onlyFrom: new Set<TaskState>(["draft"]) });
    expect(archived).toMatchObject({ state: "archived", archiveReason: "sla_expired" });
  });
});

describe("fair claims", () => {
  const runnerFor = (stage: TaskState) => (stage === "triage" ? holding : stubs.runnerFor(stage));
  /** A ticket in Intake, one `start` away from running. */
  const create = (repoPath: string) => pipeline.createTask({ title: `t ${repoPath}`, criteria: ["c"], repoPath });

  it("claims in the order tasks joined the queue, even when a queued ticket was edited meanwhile", async () => {
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 1 });
    const a = await create("/r/a");
    await pipeline.start(a.id);
    const b = await create("/r/a");
    const c = await create("/r/a");
    expect((await pipeline.start(b.id)).queued).toBe(true);
    expect((await pipeline.start(c.id)).queued).toBe(true);
    // Editing b touches updated_at, which used to send it to the back of the queue.
    await pipeline.update(b.id, { description: "clarified" });

    await pipeline.abort(a.id);
    await until(async () => !(await pipeline.get(b.id)).queued, "b to be claimed");
    // b holds the one slot, so c stays queued.
    expect((await pipeline.get(c.id)).queued).toBe(true);
  });

  it("gives a free slot to the repo with the fewest running tasks, not the oldest ticket", async () => {
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 2 });
    const a1 = await create("/r/a");
    const b0 = await create("/r/b");
    await pipeline.start(a1.id);
    await pipeline.start(b0.id);
    const a2 = await create("/r/a");
    const b1 = await create("/r/b");
    expect((await pipeline.start(a2.id)).queued).toBe(true);
    expect((await pipeline.start(b1.id)).queued).toBe(true);

    await pipeline.abort(b0.id);
    // a1 still runs for repo a, so repo b's b1 goes first although a2 queued earlier.
    await until(async () => !(await pipeline.get(b1.id)).queued, "b1 to be claimed");
    expect((await pipeline.get(a2.id)).queued).toBe(true);
  });

  it("holds a repo at its cap in the queue while slots stay free for the others", async () => {
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 3, maxPerRepo: 1 });
    const a1 = await create("/r/a");
    await pipeline.start(a1.id);
    const a2 = await create("/r/a");
    expect((await pipeline.start(a2.id)).queued).toBe(true);
    const b1 = await create("/r/b");
    expect((await pipeline.start(b1.id)).queued).toBe(false);
    // A fill pass, finished, with a slot free: a2 still waits for its repo.
    await pipeline.tick();
    expect((await pipeline.get(a2.id)).queued).toBe(true);
  });
});

/** Polls until `check` holds, for up to three seconds: a loop's end is not synchronous with
 *  the call that caused it, and a CI runner is slower than a laptop. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** For the tests that abort or shut down holding loops and then wait on what follows: each
 *  step is a round of database writes and a 20-50 ms poll (abort's untilLoopEnds, shutdown's
 *  wind-down), which on a loaded CI runner adds up past the 5 s default with nothing wrong. */
const WIND_DOWN_TIMEOUT_MS = 15_000;

describe("per-stage caps", () => {
  it("holds a stage at its cap in the queue while another stage still takes the free slots", async () => {
    const runnerFor = (stage: TaskState) => (stage === "triage" || stage === "implementing" ? holding : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 4, maxPerStage: { triage: 1 } });
    const a = await newTask();
    await pipeline.start(a.id);
    const b = await newTask();
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: true });
    await pipeline.tick();
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });

    // Another stage is not held by triage's cap: c reaches implementing (and holds there) with its own slot.
    await db.query("update tasks set state = 'implementing', queued = true, queued_at = now() where id = $1", [(await newTask()).id]);
    await pipeline.tick();
    expect((await pipeline.list()).filter((t) => t.state === "implementing" && !t.queued)).toHaveLength(1);
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });

    // Triage's slot frees: b goes.
    await pipeline.abort(a.id);
    await until(async () => !(await pipeline.get(b.id)).queued, "b to be claimed");
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: false });
    await pipeline.shutdown();
  }, WIND_DOWN_TIMEOUT_MS);

  it("parks a task between stages when its next stage is at cap, and the supervisor picks it up later", async () => {
    // The first test_design holds its slot until aborted; later ones pass.
    let held = 0;
    const holdOnce: StageRunner = (context) => (held++ === 0 ? holding(context) : Promise.resolve({ outcome: "pass" }));
    const runnerFor = (stage: TaskState) => (stage === "test_design" ? holdOnce : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, maxConcurrentTasks: 4, maxPerStage: { test_design: 1 } });
    const b = await newTask();
    // a is parked at test_design, and takes its one slot (and holds).
    const a = await newTask();
    await db.query("update tasks set state = 'test_design', queued = true, queued_at = now() where id = $1", [a.id]);
    const ticked = pipeline.tick();
    await until(async () => held === 1, "a to hold test_design");
    // b's triage passes; its plan stage is parked before test_design, whose slot is a's.
    expect(await pipeline.start(b.id)).toMatchObject({ state: "test_design", queued: true });
    expect((await pipeline.events(b.id)).map((e) => e.kind)).toContain("stage.held");
    await pipeline.abort(a.id);
    await ticked;
    await pipeline.tick();
    expect(await pipeline.get(b.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  }, WIND_DOWN_TIMEOUT_MS);

  it("reads MACHINE_MAX_PER_STAGE as stage=n pairs", () => {
    expect(loadConfig({ HOME: "/h" }).maxPerStage).toEqual({});
    expect(loadConfig({ HOME: "/h", MACHINE_MAX_PER_STAGE: "implementing=2, e2e=1" }).maxPerStage).toEqual({ implementing: 2, e2e: 1 });
    expect(() => loadConfig({ HOME: "/h", MACHINE_MAX_PER_STAGE: "implementing=0" })).toThrow(/MACHINE_MAX_PER_STAGE/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_MAX_PER_STAGE: "flying=1" })).toThrow(/MACHINE_MAX_PER_STAGE/);
  });

  it("lets a repo's PIPELINE.md cap its own concurrency below the machine's", async () => {
    const runnerFor = (stage: TaskState) => (stage === "triage" ? holding : stubs.runnerFor(stage));
    const policies = { for: async (repoPath: string | null) => ({ ...DEFAULT_POLICY, maxConcurrent: repoPath === "/r/a" ? 1 : null }) };
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, maxConcurrentTasks: 4, policies });
    const a1 = await pipeline.createTask({ title: "a1", repoPath: "/r/a" });
    await pipeline.start(a1.id);
    const a2 = await pipeline.createTask({ title: "a2", repoPath: "/r/a" });
    expect((await pipeline.start(a2.id)).queued).toBe(true);
    const b1 = await pipeline.createTask({ title: "b1", repoPath: "/r/b" });
    expect((await pipeline.start(b1.id)).queued).toBe(false);
    await pipeline.tick();
    expect((await pipeline.get(a2.id)).queued).toBe(true);
    await pipeline.shutdown();
  });
});

describe("ci_watch outside the pool", () => {
  /** A ci_watch that polls until told the checks are green. */
  let green: (() => void) | undefined;
  const polling: StageRunner = () => new Promise<StageResult>((resolve) => { green = () => resolve({ outcome: "pass" }); });
  beforeEach(() => {
    green = undefined;
  });

  it("gives the slot back while polling, and takes one again (or queues) for the stage after", async () => {
    const runnerFor = (stage: TaskState) => (stage === "ci_watch" ? polling : stage === "triage" ? holding : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 1 });
    const a = await newTask();
    await db.query("update tasks set state = 'ci_watch', queued = true, queued_at = now() where id = $1", [a.id]);
    await pipeline.tick();
    await until(async () => green !== undefined, "a to be polling");
    expect(await pipeline.get(a.id)).toMatchObject({ state: "ci_watch", queued: false });
    expect(pipeline.slots).toMatchObject({ max: 1, active: 0 });

    // The one slot is free for b while a polls.
    const b = await newTask();
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: false });
    expect(pipeline.slots.active).toBe(1);

    // CI goes green: a's next stage needs a slot, b holds it, so a waits in the queue.
    green!();
    await until(async () => (await pipeline.events(a.id)).some((e) => e.kind === "slot.waited"), "a to wait for a slot");
    expect(await pipeline.get(a.id)).toMatchObject({ state: "evidence", queued: true });
    await pipeline.abort(b.id);
    await until(async () => (await pipeline.get(a.id)).state === "awaiting_ship", "a to reach the ship gate");
    expect(await pipeline.get(a.id)).toMatchObject({ state: "awaiting_ship", queued: false });
    await pipeline.shutdown();
  }, WIND_DOWN_TIMEOUT_MS);
});

describe("shipping outside the pool", () => {
  it("gives the slot back while the monitor waits for a merge, so another task can start", async () => {
    let merged: (() => void) | undefined;
    const waiting: StageRunner = () => new Promise<StageResult>((resolve) => { merged = () => resolve({ outcome: "pass" }); });
    const runnerFor = (stage: TaskState) => (stage === "shipping" ? waiting : stage === "triage" ? holding : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 1 });
    const a = await newTask();
    await db.query("update tasks set state = 'shipping', queued = true, queued_at = now() where id = $1", [a.id]);
    await pipeline.tick();
    await until(async () => merged !== undefined, "a to be waiting on the merge");
    expect(pipeline.slots).toMatchObject({ max: 1, active: 0 });
    const b = await newTask();
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: false });
    merged!();
    await until(async () => (await pipeline.get(a.id)).state === "reviewing_memory", "a to reach the retro gate");
    await pipeline.abort(b.id);
    await pipeline.shutdown();
  }, WIND_DOWN_TIMEOUT_MS);

  it("runs a shipping stage again after a restart instead of escalating it, and likewise ci_watch", async () => {
    for (const [stage, next] of [["shipping", "reviewing_memory"], ["ci_watch", "evidence"]] as const) {
      const task = await newTask();
      await db.query("update tasks set state = $2, queued = false, updated_at = now() - interval '5 minutes' where id = $1", [task.id, stage]);
      await db.query(`insert into stage_runs (task_id, stage, attempt, status, started_at) values ($1, $2, 1, 'running', now() - interval '5 minutes')`, [task.id, stage]);
      const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
      expect(await restarted.recover()).toBe(0);
      const runs = (await restarted.stageRuns(task.id)).filter((r) => r.stage === stage);
      expect(runs).toMatchObject([{ attempt: 1, status: "aborted" }, { attempt: 2, status: "passed" }]);
      expect((await restarted.get(task.id)).state).not.toBe("escalated");
      expect((await restarted.events(task.id)).map((e) => e.kind)).toContain("stage.restarted");
      expect(next).toBeTruthy();
    }
  });
});

describe("the engine a stage run started on", () => {
  it("is recorded on the run as soon as the runner knows it, and shown with the run", async () => {
    const task = await newTask();
    const runnerFor = (stage: TaskState): StageRunner =>
      stage === "triage"
        ? async (context) => {
            await context.started?.({ container: "hardness-t1", inputCommit: null, engine: "claude:opus" });
            return stubs.runnerFor(stage)(context);
          }
        : stubs.runnerFor(stage);
    const p = new Pipeline(db, runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    await p.start(task.id);
    const [run] = await p.stageRuns(task.id);
    expect(run).toMatchObject({ stage: "triage", containerId: "hardness-t1", engine: "claude:opus" });
    expect(toStageRun(run!).engine).toBe("claude:opus");
  });
});

describe("the run record a stage run ended with", () => {
  it("stores the runtime, the pinned model, the SDK version and the fingerprint, and shows them with the run", async () => {
    const task = await newTask();
    const info = { runtime: "eve", engine: "codex:sol", modelId: "gpt-5.6-terra", sdk: { name: "eve", version: "1.0.0-rc.1" }, fingerprint: "f".repeat(64) };
    const runnerFor = (stage: TaskState): StageRunner =>
      stage === "triage" ? async (context) => ({ ...(await stubs.runnerFor(stage)(context)), run: { info } }) : stubs.runnerFor(stage);
    const p = new Pipeline(db, runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    await p.start(task.id);
    const [run] = await p.stageRuns(task.id);
    expect(run).toMatchObject({ runtime: "eve", modelId: "gpt-5.6-terra", sdkVersion: "1.0.0-rc.1", fingerprint: info.fingerprint });
    expect(toStageRun(run!)).toMatchObject({ runtime: "eve", modelId: "gpt-5.6-terra", sdkVersion: "1.0.0-rc.1", fingerprint: info.fingerprint });
  });

  it("is null on a run whose result named none", async () => {
    const task = await newTask();
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    await p.start(task.id);
    const [run] = await p.stageRuns(task.id);
    expect(toStageRun(run!)).toMatchObject({ runtime: null, modelId: null, sdkVersion: null, fingerprint: null });
  });
});

describe("re-attaching to a container after a restart", () => {
  const running = (id: string, container: string) =>
    db
      .query("update tasks set state = 'implementing', queued = false, updated_at = now() - interval '5 minutes' where id = $1", [id])
      .then(() =>
        db.query(
          `insert into stage_runs (task_id, stage, attempt, status, container_id, input_commit, engine, started_at)
           values ($1, 'implementing', 1, 'running', $2, 'abc123', 'claude:sonnet', now() - interval '5 minutes')`,
          [id, container],
        ),
      );

  it("waits for a stage container still running at boot instead of killing it, and carries on from its result", async () => {
    const task = await newTask();
    await running(task.id, "hardness-c1");
    let resumed: StageContext["resume"];
    const runnerFor = (stage: TaskState): StageRunner =>
      stage === "implementing"
        ? async (context) => {
            resumed = context.resume;
            return { outcome: "pass", run: { containerId: context.resume?.container } };
          }
        : stubs.runnerFor(stage);
    const restarted = new Pipeline(db, runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, containerRunning: async (name) => name === "hardness-c1" });
    expect(await restarted.recover()).toBe(0);
    // The engine it started on comes along, so the stage carries on with the same one.
    expect(resumed).toEqual({ container: "hardness-c1", inputCommit: "abc123", engine: "claude:sonnet" });
    expect((await restarted.get(task.id)).state).toBe("awaiting_ship");
    const runs = await restarted.stageRuns(task.id);
    expect(runs.filter((r) => r.stage === "implementing")).toMatchObject([{ attempt: 1, status: "passed", containerId: "hardness-c1" }]);
    expect((await restarted.events(task.id)).map((e) => e.kind)).toContain("stage.reattached");
  });

  it("still escalates when the container is gone", async () => {
    const task = await newTask();
    await running(task.id, "hardness-c1");
    const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, containerRunning: async () => false });
    expect(await restarted.recover()).toBe(1);
    expect(await restarted.get(task.id)).toMatchObject({ state: "escalated", resumeTo: "implementing" });
    expect((await restarted.stageRuns(task.id))[0]).toMatchObject({ status: "aborted" });
  });

  it("records the container and the input commit when a stage starts, so a restart can find them", async () => {
    const task = await newTask();
    const runnerFor = (stage: TaskState): StageRunner =>
      stage === "triage"
        ? async (context) => {
            await context.started?.({ container: "hardness-t1", inputCommit: "def456" });
            return { outcome: "pass" };
          }
        : stubs.runnerFor(stage);
    pipeline = new Pipeline(db, runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    await pipeline.start(task.id);
    expect((await pipeline.stageRuns(task.id))[0]).toMatchObject({ containerId: "hardness-t1", inputCommit: "def456", status: "passed" });
  });
});

describe("restart policy", () => {
  let reached = 0;
  const counting: StageRunner = (context) => {
    reached++;
    return holding(context);
  };
  const runnerFor = (stage: TaskState) => (stage === "triage" ? counting : stubs.runnerFor(stage));

  it("parks running tasks in the queue on shutdown, so a restart resumes them with no approval", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 1 });
    const a = await newTask();
    const b = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: true });

    await pipeline.shutdown();

    expect(await pipeline.get(a.id)).toMatchObject({ state: "triage", queued: true, reason: null });
    expect((await pipeline.stageRuns(a.id)).at(-1)).toMatchObject({ stage: "triage", status: "aborted" });
    expect((await pipeline.events(a.id)).map((e) => e.kind)).toContain("task.parked");
    // The slot a freed must not be filled while shutting down.
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });
    expect(await stagesRun(b.id)).toEqual([]);

    const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    expect(await restarted.recover()).toBe(0);
    expect((await restarted.get(a.id)).state).toBe("awaiting_approval");
    expect((await restarted.get(b.id)).state).toBe("awaiting_approval");
  }, WIND_DOWN_TIMEOUT_MS);

  it("starts nothing from a fill pass already under way when shutdown begins", async () => {
    reached = 0;
    // The pass stops on its repo-policy lookup until let go, so shutdown begins while it is in flight.
    let inFlight = 0;
    let letGo = () => {};
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    const policies = { for: async () => (inFlight++, await gate, DEFAULT_POLICY) };
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, maxConcurrentTasks: 1, policies });
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await pipeline.createTask({ title: "b", repoPath: "/r/b" });
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: true });
    pipeline.setSlots(2);
    while (inFlight < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    const stopped = pipeline.shutdown();
    letGo();
    await stopped;

    // The pass's claim lands after shutdown parked a: neither a nor b may start a stage.
    expect(pipeline.slots.active).toBe(0);
    expect(await pipeline.get(a.id)).toMatchObject({ state: "triage", queued: true });
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });
    expect(await stagesRun(b.id)).toEqual([]);
    expect(reached).toBe(1);
  });

  it("escalates them instead under the escalate policy, as before", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, restartPolicy: "escalate" });
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    await pipeline.shutdown();
    expect(await pipeline.get(a.id)).toMatchObject({ state: "escalated", reason: "aborted", resumeTo: "triage", queued: false });
  });
});

describe("deleting a task", () => {
  it("removes its worktree from disk too, so a deleted task leaves nothing behind", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "delete-")));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repoPath, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const task = await pipeline.createTask({ title: "Login page", repoPath });
    const workspace = workspaceFor(task, repoPath, join(root, "wt"));
    await ensureWorktree(repoPath, workspace);
    await db.query("update tasks set branch = $2, worktree_path = $3 where id = $1", [task.id, workspace.branch, workspace.path]);

    await pipeline.delete(task.id);

    expect(existsSync(workspace.path)).toBe(false);
    await expect(pipeline.get(task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("removing a card's clone", () => {
  it("removes a clone from disk, but says so instead of silently dropping commits no remote has", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rmclone-")));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repoPath, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const task = await pipeline.createTask({ title: "Login page", repoPath });
    const workspace = workspaceFor(task, repoPath, join(root, "wt"));
    await ensureClone(repoPath, workspace);
    await db.query("update tasks set branch = $2, worktree_path = $3 where id = $1", [task.id, workspace.branch, workspace.path]);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    await commitAll(workspace.path, "feat: b");

    await expect(pipeline.removeWorktree(task.id)).rejects.toBeInstanceOf(WorktreeUnpushedError);
    expect(existsSync(workspace.path)).toBe(true);
    expect((await pipeline.removeWorktree(task.id, { discard: true })).worktreePath).toBeNull();
    expect(existsSync(workspace.path)).toBe(false);
  });
});

describe("a card's kept sandbox", () => {
  it("is released when the card's next stage starts, so the extra folders of an escalation do not outlive the resume", async () => {
    const released: string[] = [];
    pipeline = new Pipeline(db, stubs.runnerFor, { hasConfig: () => true, policies: previewOn, releaseKept: async (id: string) => void released.push(id) });
    const card = await newTask();
    await pipeline.start(card.id);
    await until(async () => released.length > 0, "the release");
    expect(released[0]).toBe(card.id);
  });
});

describe("drain and slots", () => {
  let reached = 0;
  const runnerFor = (stage: TaskState) =>
    stage === "triage"
      ? (context: Parameters<StageRunner>[0]) => {
          reached++;
          return holding(context);
        }
      : stubs.runnerFor(stage);

  it("draining takes no new work while running stages finish; resume picks the queue back up", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 2 });
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pipeline.drain()).toMatchObject({ max: 2, active: 1, draining: true });
    const b = await newTask();
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: true });
    expect((await pipeline.get(a.id)).state).toBe("triage");
    await pipeline.tick();
    expect((await pipeline.get(b.id)).queued).toBe(true);

    expect(pipeline.resumeClaims()).toMatchObject({ draining: false });
    await until(async () => reached === 2, "b to be claimed and running");
    expect((await pipeline.get(b.id)).queued).toBe(false);
  });

  it("slots can be resized at run time; a smaller pool queues new work, a larger one fills", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { hasConfig: () => true, policies: previewOn, maxConcurrentTasks: 1 });
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await newTask();
    expect((await pipeline.start(b.id)).queued).toBe(true);
    expect(pipeline.setSlots(2)).toMatchObject({ max: 2 });
    await until(async () => reached === 2, "b to be claimed and running");
    expect((await pipeline.get(b.id)).queued).toBe(false);
    expect(() => pipeline.setSlots(0)).toThrow(/at least 1/);
    expect(pipeline.slots).toMatchObject({ max: 2, active: 2, draining: false });
  });
});

describe("rate limits", () => {
  it("pauses on a usage limit and re-runs the same stage when the window resets", async () => {
    stubs.plan("implementing", { outcome: "pass", rateLimited: true });
    const task = await newTask();

    const paused = await startAndApprove(task.id);
    expect(paused).toMatchObject({ state: "paused_rate_limit", resumeTo: "implementing" });
    expect((await pipeline.stageRuns(task.id)).at(-1)).toMatchObject({
      stage: "implementing",
      status: "paused",
    });

    const resumed = await pipeline.windowReset(task.id);
    expect(resumed.state).toBe("awaiting_ship");
  });

  it("schedules the resume from a string resetsAt, the shape older runners wrote", async () => {
    vi.useFakeTimers();
    try {
      const inOneHour = Math.floor(Date.now() / 1000) + 3600;
      stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: String(inOneHour) } });
      const task = await newTask();
      const paused = await startAndApprove(task.id);
      expect(paused.state).toBe("paused_rate_limit");
      expect(pipeline.hasResumeTimer(task.id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can abort a paused task, which then waits for you", async () => {
    stubs.plan("e2e", { outcome: "pass", rateLimited: true });
    const task = await newTask();
    await startAndApprove(task.id);

    const aborted = await pipeline.abort(task.id);
    expect(aborted).toMatchObject({ state: "escalated", resumeTo: "e2e", reason: "aborted" });
  });
});

describe("invalid requests", () => {
  it("rejects an action that does not fit the state and changes nothing", async () => {
    const task = await newTask();

    await expect(pipeline.decide(task.id, "approved")).rejects.toBeInstanceOf(TransitionError);
    expect((await pipeline.get(task.id)).state).toBe("draft");
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toEqual(["task.created"]);
    expect(await pipeline.approvals(task.id)).toEqual([]);
  });

  it("reports unknown tasks", async () => {
    await expect(pipeline.start("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
});

describe("concurrency", () => {
  it("queues a task past the limit and runs it once a slot frees", async () => {
    let finishFirst: (() => void) | undefined;
    // Ends on an abort too: b still runs when the test ends, and the next beforeEach's shutdown stops it.
    const blocking: StageRunner = (context) =>
      new Promise<StageResult>((resolve) => {
        finishFirst = () => resolve({ outcome: "pass" });
        void holding(context).then(resolve);
      });
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? blocking : stubs.runnerFor(stage)), {
      policies: previewOn,
      maxConcurrentTasks: 1,
    });

    const a = await newTask();
    const b = await newTask();

    const startedA = await pipeline.start(a.id);
    expect(startedA).toMatchObject({ state: "triage", queued: false });
    // a's stage loop runs in the background; wait until it actually reaches the stub
    // before relying on `finishFirst`, rather than assuming it is set by now.
    while (!finishFirst) await new Promise((resolve) => setTimeout(resolve, 5));

    const startedB = await pipeline.start(b.id);
    expect(startedB).toMatchObject({ state: "triage", queued: true });

    finishFirst();
    while ((await pipeline.get(a.id)).state !== "awaiting_approval") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect((await pipeline.get(a.id)).state).toBe("awaiting_approval");
    // b is claimed after a's loop returns, which is after a's last transition is stored,
    // so there is a short window where a is done and b is still queued: wait it out.
    const deadline = Date.now() + 2000;
    while ((await pipeline.get(b.id)).queued && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: false });
  });

  it("never lets two simultaneous starts both claim the last slot", async () => {
    // Unlike the test above (A started and confirmed running before B starts), this fires
    // both starts at once — the actual race: two schedule() calls contending for one slot,
    // not one already settled before the other begins.
    const resolvers: Array<() => void> = [];
    const blocking: StageRunner = () =>
      new Promise<StageResult>((resolve) => resolvers.push(() => resolve({ outcome: "pass" })));
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? blocking : stubs.runnerFor(stage)), {
      policies: previewOn,
      maxConcurrentTasks: 1,
    });

    const a = await newTask();
    const b = await newTask();

    const [startedA, startedB] = await Promise.all([pipeline.start(a.id), pipeline.start(b.id)]);

    expect([startedA.queued, startedB.queued].filter(Boolean)).toHaveLength(1);
    // dispatch() returns as soon as a slot is reserved, before the stage loop actually
    // reaches the runner — wait for that so `resolvers` reflects who's really running.
    while (resolvers.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolvers).toHaveLength(1);

    resolvers[0]?.();
    while (resolvers.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    resolvers[1]?.();

    while ((await pipeline.get(a.id)).state !== "awaiting_approval" || (await pipeline.get(b.id)).state !== "awaiting_approval") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect((await pipeline.get(a.id)).state).toBe("awaiting_approval");
    expect((await pipeline.get(b.id)).state).toBe("awaiting_approval");
  });
});

describe("events", () => {
  it("tells listeners about every logged event, in order", async () => {
    const seen: string[] = [];
    pipeline = new Pipeline(db, stubs.runnerFor, {
      policies: previewOn,
      inline: true, hasConfig: () => true,
      onEvent: (event) => {
        seen.push(event.kind);
      },
    });
    const task = await newTask();
    await pipeline.start(task.id);

    expect(seen).toEqual([
      "task.created",
      "transition",
      "stage.started",
      "stage.finished",
      "transition",
      "stage.started",
      "stage.finished",
      "transition",
    ]);
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toEqual(seen);
  });
});

describe("ingested stage output", () => {
  it("stores events, artifacts and usage the runner reports", async () => {
    const task = await newTask();
    stubs.plan("triage", {
      outcome: "pass",
      events: [{ at: "2026-01-01T00:00:00Z", kind: "tool", payload: { name: "Read" } }, { at: "t", kind: "stage.note", payload: {} }],
      artifacts: [{ kind: "report", path: "/tmp/r.md", label: "R", sha256: "abc" }],
      usage: { turns: 4, costUsd: 0.25 },
    });
    await pipeline.start(task.id);

    const kinds = (await pipeline.events(task.id)).map((e) => e.kind);
    expect(kinds).toContain("stage.tool");
    expect(kinds).toContain("stage.note");
    expect(kinds).not.toContain("stage.stage.note");
    const [run] = await pipeline.stageRuns(task.id);
    const tool = (await pipeline.events(task.id)).find((e) => e.kind === "stage.tool");
    expect(tool).toMatchObject({ stageRunId: run?.id, payload: { name: "Read", at: "2026-01-01T00:00:00Z" } });
    expect(await pipeline.artifacts(task.id)).toMatchObject([
      { kind: "report", path: "/tmp/r.md", label: "R", sha256: "abc", stageRunId: run?.id },
    ]);
    expect(run?.turns).toBe(4);
    expect(Number(run?.costUsd)).toBe(0.25);
  });

  it("shows needsInput and requested actions on the approval", async () => {
    const task = await newTask();
    const needsInput = [{ question: "Which db?", recommended: "pg" }];
    const requested = [{ kind: "tracker_write" as const, target: "o/r#1", payload: { body: "hi" } }];
    stubs.plan("triage", { outcome: "needs_input", needsInput, requested, detail: { summary: "s" } });
    const asking = await pipeline.start(task.id);

    expect(asking.state).toBe("awaiting_answers");
    const [approval] = await pipeline.approvals(task.id);
    expect(approval?.requested).toMatchObject({ summary: "s", questions: needsInput, actions: requested });
    // An agent's own questions are not posted by themselves: they wait for a tap.
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.questions")).toEqual([]);
    const tapped = await pipeline.postQuestions(task.id);
    expect(tapped.posted).toBe(true);
    const asked = (await pipeline.events(task.id)).filter((e) => e.kind === "task.questions");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.payload).toMatchObject({ body: "Luna needs your answers to go on: 1) Which db? (suggested: pg)", secret: false, by: "person" });
    // The same questions are posted once, however many taps.
    expect((await pipeline.postQuestions(task.id)).posted).toBe(false);
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.questions")).toHaveLength(1);
  });

  it("posts the questions the machine built from the signals by itself, once, and refuses one that carries a token", async () => {
    const built = [{ question: "Is this a bug or a feature? The model read it as a bug, 0.62", recommended: "bug" }];
    stubs.plan("triage", { outcome: "needs_input", needsInput: built, detail: { summary: "s", questionsBy: "machine" } });
    const task = await newTask();
    await pipeline.start(task.id);
    const asked = (await pipeline.events(task.id)).filter((e) => e.kind === "task.questions");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.payload).toMatchObject({ body: expect.stringContaining("Is this a bug or a feature?"), secret: false, by: "machine" });
    // A triage re-run after a crash asks the same questions: nothing new is posted.
    const again = await (pipeline as unknown as { postQuestionsOnce(id: string, q: typeof built, by: "machine"): Promise<boolean> }).postQuestionsOnce(task.id, built, "machine");
    expect(again).toBe(false);
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.questions")).toHaveLength(1);

    const leaky = [{ question: `Is this ${["ghp", "a".repeat(36)].join("_")} a bug?`, recommended: null }];
    stubs.plan("triage", { outcome: "needs_input", needsInput: leaky, detail: { summary: "s" } });
    const other = await newTask();
    await pipeline.start(other.id);
    await expect(pipeline.postQuestions(other.id)).rejects.toBeInstanceOf(QuestionsCarrySecretError);
    stubs.plan("triage", { outcome: "needs_input", needsInput: leaky, detail: { summary: "s", questionsBy: "machine" } });
    const auto = await newTask();
    await pipeline.start(auto.id);
    expect((await pipeline.events(auto.id)).find((e) => e.kind === "task.questions")?.payload).toMatchObject({ secret: true });
  });

  it("answers the tap with no_questions away from the questions gate", async () => {
    const task = await newTask();
    await expect(pipeline.postQuestions(task.id)).rejects.toBeInstanceOf(NoQuestionsToPostError);
  });
});

describe("concurrent transitions on the same task", () => {
  it("never lets two concurrent decide() calls on the same task both succeed", async () => {
    const task = await newTask();
    await pipeline.start(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");

    const [a, b] = await Promise.allSettled([
      pipeline.decide(task.id, "approved"),
      pipeline.decide(task.id, "approved"),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    // The row lock serializes the two transactions: whichever runs second sees the task
    // already past awaiting_approval and its transition is rejected, not silently duplicated.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransitionError);
  });
});


describe("closing the loop", () => {
  it("logs ship.merged (not task.shipped) with the merge, its method and the pack's facts when shipping passes with a merge, and not otherwise", async () => {
    const merged = await newTask();
    stubs.plan("shipping", { outcome: "pass", detail: { merged: { sha: "m".repeat(40), by: "machine", method: "rebase" }, prUrl: "https://github.com/o/a/pull/3", number: 3 } });
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    await p.start(merged.id);
    for (let i = 0; i < 2; i++) await p.decide(merged.id, "approved");
    const event = (await p.events(merged.id)).find((e) => e.kind === "ship.merged");
    expect(event?.payload).toMatchObject({ title: merged.title, prUrl: "https://github.com/o/a/pull/3", number: 3, mergedSha: "m".repeat(40), by: "machine", method: "rebase", media: [] });
    expect((await p.events(merged.id)).map((e) => e.kind)).not.toContain("task.shipped");

    stubs.reset();
    const plain = await newTask();
    await p.start(plain.id);
    for (let i = 0; i < 2; i++) await p.decide(plain.id, "approved");
    expect((await p.events(plain.id)).map((e) => e.kind)).not.toContain("ship.merged");
  });
});

describe("a PR closed without a merge archives its card", () => {
  const closed = { outcome: "fail" as const, detail: { prClosed: true } };
  const reasons = async (p: Pipeline, id: string) => ({ task: await p.get(id), kinds: (await p.events(id)).map((e) => e.kind) });

  it("the watch answering prClosed archives the card with pr_closed and runs the close step", async () => {
    stubs.plan("awaiting_ship", closed);
    const closes: string[] = [];
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, releaseKept: async (id) => void closes.push(id), closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false, watcher: { close: async (id) => void watched.push(id) } } });
    const watched: string[] = [];
    const task = await newTask();
    await p.start(task.id);
    await p.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await p.decide(task.id, "approved");
    const out = await reasons(p, task.id);
    expect(out.task).toMatchObject({ state: "archived", archiveReason: "pr_closed" });
    expect(closes).toContain(task.id);
    // The real close step ran (its report is logged and the watch tab closed), not just the kept-sandbox release.
    expect(out.kinds).toContain("task.closed");
    expect(watched).toContain(task.id);
    expect(out.kinds).not.toContain("ship.merged");
  });

  it("shipping answering prClosed archives it too, and an escalation is not what a closed PR becomes", async () => {
    stubs.plan("shipping", closed);
    const p = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    await p.start(task.id);
    await p.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await p.decide(task.id, "approved");
    expect(await p.get(task.id)).toMatchObject({ state: "archived", archiveReason: "pr_closed" });
  });

  it("prClosed from any other stage is just a failure: nothing but those two stages archives on it", async () => {
    stubs.plan("evidence", closed);
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    expect((await pipeline.get(task.id)).state).not.toBe("archived");
  });
});

describe("the Build Report and the Verify Report ride on the finishes", () => {
  const finish = async (id: string, stage: string) => (await pipeline.events(id)).filter((e) => e.kind === "stage.finished" && e.payload.stage === stage).at(-1);

  it("attaches the Build Report to the passing implementing finish and the Verify Report to the passing ci_watch finish", async () => {
    stubs.plan("implementing", { outcome: "pass", run: { outputCommit: "b17" }, detail: { scope: { facts: { changed: ["src/a.ts"], undeclared: [], removedTests: [] } } } });
    stubs.plan("verifying", { outcome: "pass", detail: { findings: [{ path: "src/a.ts", line: 2, severity: "nit", title: "name", body: "b", confidence: 0.5 }], results: [{ outcome: "pass" }] } });
    stubs.plan("delivering", { outcome: "pass", detail: { prNumber: 42 } });
    const task = await newTask();
    await startAndApprove(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");

    const build = (await finish(task.id, "implementing"))?.payload.detail as { report?: { headSha: string; diffSummary: { files: string[] }; scopeCheck: { clean: boolean } } };
    expect(build.report).toMatchObject({ headSha: "b17", diffSummary: { files: ["src/a.ts"] }, scopeCheck: { clean: true }, version: 2 });
    const verify = (await finish(task.id, "ci_watch"))?.payload.detail as { report?: { prNumber: number; findings: { title: string }[]; tests: { total: number } } };
    expect(verify.report).toMatchObject({ prNumber: 42, tests: { total: 1 }, version: 2 });
    expect(verify.report?.findings.map((f) => f.title)).toEqual(["name"]);

    const reports = await pipeline.reports(task.id);
    expect(reports.build).toMatchObject({ headSha: "b17" });
    expect(reports.verify).toMatchObject({ prNumber: 42 });
  });

  it("leaves a failing finish without a report, and the reports null before their stage passed", async () => {
    stubs.plan("implementing", { outcome: "fail" });
    const task = await newTask();
    await startAndApprove(task.id);
    const first = (await pipeline.events(task.id)).find((e) => e.kind === "stage.finished" && e.payload.stage === "implementing");
    expect(first?.payload).toMatchObject({ status: "failed" });
    expect(first?.payload.detail).toBeUndefined();
    expect(await pipeline.reports((await newTask()).id)).toEqual({ build: null, verify: null });
  });
});

describe("the rows the diagram names that had none", () => {
  const kinds = async (id: string) => (await pipeline.events(id)).map((e) => e.kind);

  it("logs verify.findings, ci.status and evidence.media_ready once, with counts only, beside the finishes", async () => {
    stubs.plan("verifying", { outcome: "pass", detail: { findings: [{ path: "a", line: 1, severity: "bug", title: "free text", body: "more free text", confidence: 1 }] } });
    stubs.plan("ci_watch", { outcome: "pass", detail: { checks: [{ name: "a", state: "SUCCESS" }, { name: "b", state: "FAILURE" }] } });
    stubs.plan("evidence", { outcome: "pass", detail: { artifactCount: 2 } });
    const task = await newTask();
    await startAndApprove(task.id);
    const events = await pipeline.events(task.id);
    const row = (kind: string) => events.filter((e) => e.kind === kind);
    expect(row("verify.findings").map((e) => e.payload)).toEqual([{ count: 1, blockers: 1, shouldFix: 0, nits: 0 }]);
    expect(row("ci.status").map((e) => e.payload)).toEqual([{ state: "red", total: 2, failed: 1 }]);
    expect(row("evidence.media_ready").map((e) => e.payload)).toEqual([{ count: 2 }]);
    expect(JSON.stringify(row("verify.findings"))).not.toContain("free text");
  });

  it("logs card.fast_lane when triage chose the fast lane, and nothing for the plan route", async () => {
    const plain = await newTask();
    await pipeline.start(plain.id);
    expect(await kinds(plain.id)).not.toContain("card.fast_lane");
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "fast_lane" } });
    const fast = await newTask();
    await pipeline.start(fast.id);
    expect((await kinds(fast.id)).filter((k) => k === "card.fast_lane")).toHaveLength(1);
  });
});

describe("what a running stage may emit", () => {
  it("logs an allowlisted row and drops any other kind with a warning, never logging it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitting: StageRunner = async (context) => {
      await context.emit?.("ship.ready", {});
      await (context.emit as unknown as (kind: string, payload: object) => Promise<void>)("transition", { event: "approved", from: "awaiting_approval", to: "implementing" });
      await (context.emit as unknown as (kind: string, payload: object) => Promise<void>)("task.reply", { text: "hi" });
      return { outcome: "pass", detail: { outcome: "plan", record: { kind: "feature", goal: "g", size: "small", urgency: "normal", risk: "low", reason: "r" }, criteria: [] } };
    };
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? emitting : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
    const task = await newTask();
    await pipeline.start(task.id);
    const kinds = (await pipeline.events(task.id)).map((e) => e.kind);
    expect(kinds).toContain("ship.ready");
    expect(kinds.filter((k) => k === "task.reply")).toEqual([]);
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "transition" && e.payload.event === "approved")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("a Slack thread attached to a card", () => {
  const thread = { channel: "C1", ts: "1700000000.000100", permalink: "https://x.slack.com/archives/C1/p1700000000000100", authorId: "U2" };
  it("goes into the card's links and its author into the followers, never into the sources, and is logged with ids only", async () => {
    const task = await pipeline.createTask({ title: "Login page", source: { kind: "jira", key: "PAY-1", url: "https://x/PAY-1", issueType: "Task" } });
    const out = await pipeline.attachThread(task.id, thread);
    const card = (await pipeline.get(task.id)).card!;
    expect(card.links).toMatchObject({ "slack:C1:1700000000.000100": thread.permalink });
    expect(card.followers).toContain("U2");
    expect(card.sources).toHaveLength(1);
    expect(out).toEqual({ priority: null });
    const event = (await pipeline.events(task.id)).find((e) => e.kind === "conversation.attached");
    expect(event?.payload).toEqual({ channel: "C1", ts: "1700000000.000100" });
    await pipeline.attachThread(task.id, thread);
    expect((await pipeline.get(task.id)).card!.followers.filter((f) => f === "U2")).toHaveLength(1);
  });
  it("answers the card's priority when it has one", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    await db.query("update tasks set record = $1 where id = $2", [JSON.stringify({ urgencyDetail: { priority: "P1", subScores: {} } }), task.id]);
    expect(await pipeline.attachThread(task.id, thread)).toEqual({ priority: "P1" });
  });
});

describe("the address of a card's PR", () => {
  it("is known as soon as the PR exists (the stage that opened it finished), not only after a merge", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    expect(await pipeline.prLinkOf(task.id)).toBeNull();
    await pipeline.record(task.id, "stage.finished", { detail: { prUrl: "https://github.com/acme/app/pull/4", prNumber: 4 } });
    expect(await pipeline.prLinkOf(task.id)).toBe("https://github.com/acme/app/pull/4");
    await pipeline.record(task.id, "stage.finished", { detail: { prUrl: "javascript:alert(1)" } });
    expect(await pipeline.prLinkOf(task.id)).toBe("https://github.com/acme/app/pull/4");
  });
});

