import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskState } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_RETRIES, TransitionError } from "../domain/transition.ts";
import type { StageContext, StageResult, StageRunner } from "./ports.ts";
import { loadConfig } from "../config.ts";
import { StubStages } from "./stages/stubs.ts";
import { freshTestDatabase } from "../test/database.ts";
import { type BudgetAlert, Pipeline, TaskNotFoundError } from "./pipeline.ts";
import { DEFAULT_POLICY } from "../domain/policy.ts";
import { ensureWorktree, workspaceFor } from "../adapters/git/worktree.ts";
import type { CloseReport } from "./close-task.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

const fail: StageResult = { outcome: "fail" };

beforeAll(async () => {
  db = await freshTestDatabase();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true });
});

/** A ticket in Intake (draft), ready for `pipeline.start()` to run triage. */
const newTask = () => pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });

/** Starts a task and approves the plan and the test names, which reaches the implementer. */
async function startAndApprove(id: string) {
  await pipeline.start(id);
  await pipeline.decide(id, "approved");
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

  it("keeps the tracker source and starts with no artifacts", async () => {
    const source = { kind: "github", repo: "owner/name", number: 42, url: "https://github.com/owner/name/issues/42" } as const;
    const task = await pipeline.createTask({ title: "Login page", source });
    expect(task.source).toEqual(source);
    expect(await pipeline.artifacts(task.id)).toEqual([]);

    const cleared = await pipeline.update(task.id, { source: null });
    expect(cleared.source).toBeNull();
  });

  it("runs triage on start and waits for you to approve the plan", async () => {
    const task = await newTask();
    const started = await pipeline.start(task.id);

    expect(started.state).toBe("awaiting_approval");
    expect(await pipeline.stageRuns(task.id)).toMatchObject([
      { stage: "triage", attempt: 1, status: "passed", outcome: "pass" },
    ]);
    expect(await pipeline.approvals(task.id)).toMatchObject([
      { kind: "awaiting_approval", decision: null },
    ]);
  });
});

describe("the whole pipeline with stub stages", () => {
  it("runs every stage once and closes after your four approvals", async () => {
    const task = await newTask();
    await startAndApprove(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");

    await pipeline.decide(task.id, "approved");
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
      "shipping",
    ]);
    const approvals = await pipeline.approvals(task.id);
    expect(approvals.map((a) => a.kind)).toEqual([
      "awaiting_approval",
      "awaiting_test_check",
      "awaiting_ship",
      "reviewing_memory",
    ]);
    expect(approvals.every((a) => a.decision === "approved" && a.decidedAt)).toBe(true);
  });
});

describe("closing", () => {
  it("runs the close step after the last approval and logs the report", async () => {
    const seen: string[] = [];
    const closing = new Pipeline(db, stubs.runnerFor, {
      inline: true,
      closeDeps: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreeRemove: false,
        watcher: { close: async (id) => void seen.push(id) },
      },
    });
    const created = await closing.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    await closing.start(created.id);
    for (let i = 0; i < 4; i++) await closing.decide(created.id, "approved");

    expect((await closing.get(created.id)).state).toBe("closed");
    const event = (await closing.events(created.id)).find((e) => e.kind === "task.closed");
    const report = event?.payload as unknown as CloseReport;
    expect(report.steps.map((s) => s.step)).toEqual(["watch-tab", "worktree"]);
    expect(seen).toEqual([created.id]);
  });

  it("logs a failed step instead of failing the approval", async () => {
    const closing = new Pipeline(db, stubs.runnerFor, {
      inline: true,
      closeDeps: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreeRemove: false,
        watcher: { close: async () => Promise.reject(new Error("herdr down")) },
      },
    });
    const created = await closing.createTask({ title: "Login page", criteria: ["x"] });
    await closing.start(created.id);
    for (let i = 0; i < 4; i++) await closing.decide(created.id, "approved");

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
      inline: true,
      closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false },
    });

  async function toMemoryGate(p: Pipeline) {
    // reviewing_memory is a gate; the retro runs inside shipping and its rules ride on the gate.
    stubs.plan("shipping", { outcome: "pass", detail: { rules: { markdown: "- r\n" } } });
    const created = await p.createTask({ title: "Login page", criteria: ["x"] });
    await p.start(created.id);
    for (let i = 0; i < 3; i++) await p.decide(created.id, "approved");
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
    stubs.plan("triage", { outcome: "pass", detail: { brief: "b", criteria } });
    const task = await newTask();
    await pipeline.start(task.id);

    const approved = await pipeline.decide(task.id, "approved");
    expect(approved.criteria).toEqual(criteria);
  });

  it("keeps the ticket's criteria when triage proposes none", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { brief: "b", criteria: [] } });
    const task = await newTask();
    await pipeline.start(task.id);

    const approved = await pipeline.decide(task.id, "approved");
    expect(approved.criteria).toEqual(["Bad password shows an error"]);
  });
});

describe("editing the plan before approving", () => {
  it("merges edited fields into the open plan approval, keeping what you didn't touch", async () => {
    const slices = [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }];
    stubs.plan("triage", {
      outcome: "pass",
      detail: { brief: "old brief", criteria: ["c1"], assumptions: ["a1"], slices },
    });
    const task = await newTask();
    await pipeline.start(task.id);

    await pipeline.editPlan(task.id, { brief: "new brief", criteria: ["c1", "c2"] });

    const approval = (await pipeline.approvals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
    expect(approval?.requested).toMatchObject({ brief: "new brief", criteria: ["c1", "c2"], assumptions: ["a1"], slices });
  });

  it("is what gets adopted once you approve", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [] } });
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

  it("rejects editing an answers or test-check gate", async () => {
    stubs.plan("triage", { outcome: "needs_input", detail: { questions: [{ question: "q", recommended: "r" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await expect(pipeline.editPlan(task.id, { brief: "x" })).rejects.toThrow(/no plan/i);
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
    expect(await stagesRun(task.id)).toEqual(["triage", "triage"]);
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
    pipeline = new Pipeline(db, runner, { inline: true });
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
    pipeline = new Pipeline(db, runner, { inline: true });
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
    pipeline = new Pipeline(db, runner, { inline: true });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual([[], ["left uncommitted"]]);
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
    pipeline = new Pipeline(db, runner, { inline: true });
    const task = await newTask();
    await startAndApprove(task.id);
    expect(seen).toEqual([[], ["locked test file changed"]]);
  });
});

describe("retries and escalation", () => {
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

  it("treats a runner that throws as a failed run", async () => {
    const throwing: StageRunner = async () => {
      throw new Error("container exited with 137");
    };
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? throwing : stubs.runnerFor(stage)), {
      inline: true,
    });
    const task = await newTask();

    const escalated = await pipeline.start(task.id);
    expect(escalated).toMatchObject({ state: "escalated", reason: "triage failed" });
    const finished = (await pipeline.events(task.id)).find((e) => e.kind === "stage.finished");
    expect(finished?.payload).toMatchObject({ status: "failed", error: "container exited with 137" });
  });
});

describe("test_change undoes verifying's tests", () => {
  it("reverts the commit verifying's tests came in on before test_design re-plans, so the wrong test is not locked in", async () => {
    const reverted: Array<[string, string]> = [];
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, revertCommit: async (worktree, sha) => void reverted.push([worktree, sha]) });
    stubs.plan(
      "implementing",
      { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } },
      { outcome: "test_change", detail: { request: "the empty-cart test asserts the wrong text" } },
    );
    stubs.plan("verifying", { outcome: "fail", run: { inputCommit: "aaa", outputCommit: "bbb" }, detail: { findings: [] } });
    const task = await newTask();
    const after = await startAndApprove(task.id);
    // Inline, the loop went straight on into test_design, which the stub answered.
    expect(after.state).toBe("awaiting_test_check");
    expect(reverted).toEqual([["/wt/x", "bbb"]]);
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("tests.reverted");
  });

  it("escalates when the revert fails, instead of sending the task round a loop it cannot win", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, revertCommit: async () => { throw new Error("conflict in test/cart.test.js"); } });
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
      inline: true,
      diffStat: async (worktree, repoPath) => {
        diffs.push(`${worktree}@${repoPath}`);
        return { added: 142, removed: 18 };
      },
    });
    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" }, run: { inputCommit: "base1", outputCommit: "out1" } });
    stubs.plan("verifying", {
      outcome: "pass",
      detail: { step: "review", results: [{ title: "a", outcome: "pass" }, { title: "b", outcome: "fail" }, { title: "c", outcome: "pass" }] },
    });
    const task = await newTask();
    await startAndApprove(task.id);
    const row = await pipeline.get(task.id);
    expect(row).toMatchObject({ diffAdded: 142, diffRemoved: 18, testsPassed: 2, testsTotal: 3 });
    expect(diffs).toEqual(["/wt/x@null"]);
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

describe("restart recovery", () => {
  it("re-arms the resume timer of a task paused on a usage limit", async () => {
    vi.useFakeTimers();
    try {
      const inOneHour = Math.floor(Date.now() / 1000) + 3600;
      stubs.plan("implementing", { outcome: "pass", rateLimited: true, detail: { resetsAt: String(inOneHour) } });
      const task = await newTask();
      expect((await startAndApprove(task.id)).state).toBe("paused_rate_limit");

      // A new machine over the same database: no timers survive in memory.
      const restarted = new Pipeline(db, stubs.runnerFor, { inline: true });
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

    const restarted = new Pipeline(db, stubs.runnerFor, { inline: true });
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

      const restarted = new Pipeline(db, stubs.runnerFor, { inline: true });
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

describe("budgets", () => {
  const costly = (costUsd: number): StageResult => ({ outcome: "pass", usage: { turns: 1, costUsd } });
  const backdateRuns = (taskId: string) =>
    db.query("update stage_runs set started_at = now() - interval '25 hours' where task_id = $1", [taskId]);

  it("escalates a task that spent past its own ceiling before its next stage runs", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, budget: { taskUsd: 2 } });
    stubs.plan("triage", costly(3));
    const task = await newTask();
    expect((await pipeline.start(task.id)).state).toBe("awaiting_approval");

    const held = await pipeline.decide(task.id, "approved");
    expect(held).toMatchObject({ state: "escalated", reason: "budget: task spent $3.00 of $2.00", resumeTo: "test_design" });
    expect(await stagesRun(task.id)).toEqual(["triage"]);
  });

  it("holds the queue while the day's spend is over the ceiling, and drains it once it is not", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, budget: { dailyUsd: 2 } });
    stubs.plan("triage", costly(3));
    const a = await newTask();
    expect((await pipeline.start(a.id)).state).toBe("awaiting_approval");

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
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, budget: { dailyUsd: 2 } });
    stubs.plan("triage", costly(3));
    const task = await newTask();
    expect((await pipeline.start(task.id)).state).toBe("awaiting_approval");

    expect(await pipeline.decide(task.id, "approved")).toMatchObject({ state: "test_design", queued: true });
    expect(await stagesRun(task.id)).toEqual(["triage"]);
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("budget.held");

    await backdateRuns(task.id);
    await pipeline.tick();
    expect(await pipeline.get(task.id)).toMatchObject({ state: "awaiting_test_check", queued: false });
  });
});

describe("a repo's monthly budget and the alerts", () => {
  const costly = (costUsd: number): StageResult => ({ outcome: "pass", usage: { turns: 1, costUsd } });
  const policies = (monthly: Record<string, number | null>) => ({
    for: async (repoPath: string | null) => ({ ...DEFAULT_POLICY, monthlyBudgetUsd: repoPath ? (monthly[repoPath] ?? null) : null }),
  });

  it("parks a task between stages once its repo spent its month, and the queue skips that repo", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: policies({ "/r/a": 2 }) });
    stubs.plan("triage", costly(3));
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    expect((await pipeline.start(a.id)).state).toBe("awaiting_approval");
    expect(await pipeline.decide(a.id, "approved")).toMatchObject({ state: "test_design", queued: true });
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
    expect(await pipeline.get(a.id)).toMatchObject({ state: "awaiting_test_check", queued: false });
    expect(await pipeline.get(a2.id)).toMatchObject({ state: "awaiting_approval", queued: false });
  });

  it("raises each threshold once per scope: task, repo-month and day", async () => {
    const alerts: BudgetAlert[] = [];
    pipeline = new Pipeline(db, stubs.runnerFor, {
      inline: true,
      budget: { taskUsd: 10, dailyUsd: 100 },
      policies: policies({ "/r/a": 10 }),
      onAlert: (alert) => alerts.push(alert),
    });
    stubs.plan("triage", costly(8.5), costly(8.5));
    stubs.plan("test_design", costly(0.6));
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    await pipeline.start(a.id);
    expect(alerts).toEqual([
      { scope: "task", taskId: a.id, repo: "/r/a", pct: 80, spentUsd: 8.5, limitUsd: 10 },
      { scope: "repo", taskId: a.id, repo: "/r/a", pct: 80, spentUsd: 8.5, limitUsd: 10 },
    ]);
    await pipeline.decide(a.id, "approved");
    expect(alerts.slice(2)).toEqual([
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
  const policies = (minutes: number | null) => ({ for: async () => ({ ...DEFAULT_POLICY, autoApprovePlanMinutes: minutes }) });
  const confident = (over: Record<string, unknown> = {}): StageResult => ({
    outcome: "pass",
    detail: { brief: "b", confidence: "high", risk: "low", ...over },
  });

  it("approves a confident, low-risk plan by itself once the policy's minutes have passed", async () => {
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: policies(10) });
    stubs.plan("triage", confident());
    const task = await pipeline.createTask({ title: "t", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.tick();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");

    await db.query("update approvals set created_at = now() - interval '11 minutes'");
    await pipeline.tick();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_test_check");
    expect((await pipeline.approvals(task.id))[0]).toMatchObject({
      decision: "approved",
      reason: "auto-approved after 10 min: triage reported high confidence and low risk",
    });
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("plan.auto_approved");
  });

  it("keeps waiting when confidence is not high, risk is not low, triage asked questions, or the policy is off", async () => {
    const cases: Array<[number | null, StageResult]> = [
      [10, confident({ confidence: "medium" })],
      [10, confident({ risk: "medium" })],
      [10, confident({ risk: undefined })],
      [10, { outcome: "needs_input", needsInput: [{ question: "q", recommended: "r" }], detail: { confidence: "high", risk: "low" } }],
      [null, confident()],
    ];
    for (const [minutes, result] of cases) {
      await db.query("truncate tasks cascade");
      pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: policies(minutes) });
      stubs.plan("triage", result);
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

describe("fair claims", () => {
  /** A triage that holds its slot until the task is aborted. */
  const holding: StageRunner = ({ signal }) =>
    new Promise<StageResult>((resolve) => signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true }));
  const runnerFor = (stage: TaskState) => (stage === "triage" ? holding : stubs.runnerFor(stage));
  /** A ticket in Intake, one `start` away from running. */
  const create = (repoPath: string) => pipeline.createTask({ title: `t ${repoPath}`, criteria: ["c"], repoPath });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("claims in the order tasks joined the queue, even when a queued ticket was edited meanwhile", async () => {
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 1 });
    const a = await create("/r/a");
    await pipeline.start(a.id);
    const b = await create("/r/a");
    const c = await create("/r/a");
    expect((await pipeline.start(b.id)).queued).toBe(true);
    expect((await pipeline.start(c.id)).queued).toBe(true);
    // Editing b touches updated_at, which used to send it to the back of the queue.
    await pipeline.update(b.id, { description: "clarified" });

    await pipeline.abort(a.id);
    await settle();
    expect((await pipeline.get(b.id)).queued).toBe(false);
    expect((await pipeline.get(c.id)).queued).toBe(true);
  });

  it("gives a free slot to the repo with the fewest running tasks, not the oldest ticket", async () => {
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 2 });
    const a1 = await create("/r/a");
    const b0 = await create("/r/b");
    await pipeline.start(a1.id);
    await pipeline.start(b0.id);
    const a2 = await create("/r/a");
    const b1 = await create("/r/b");
    expect((await pipeline.start(a2.id)).queued).toBe(true);
    expect((await pipeline.start(b1.id)).queued).toBe(true);

    await pipeline.abort(b0.id);
    await settle();
    // a1 still runs for repo a, so repo b's b1 goes first although a2 queued earlier.
    expect((await pipeline.get(b1.id)).queued).toBe(false);
    expect((await pipeline.get(a2.id)).queued).toBe(true);
  });

  it("holds a repo at its cap in the queue while slots stay free for the others", async () => {
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 3, maxPerRepo: 1 });
    const a1 = await create("/r/a");
    await pipeline.start(a1.id);
    const a2 = await create("/r/a");
    expect((await pipeline.start(a2.id)).queued).toBe(true);
    const b1 = await create("/r/b");
    expect((await pipeline.start(b1.id)).queued).toBe(false);
    await settle();
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

describe("per-stage caps", () => {
  /** A stage that holds its slot until the task is aborted. */
  const holding: StageRunner = ({ signal }) =>
    new Promise<StageResult>((resolve) => signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("holds a stage at its cap in the queue while another stage still takes the free slots", async () => {
    const runnerFor = (stage: TaskState) => (stage === "triage" || stage === "implementing" ? holding : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 4, maxPerStage: { triage: 1 } });
    const a = await newTask();
    await pipeline.start(a.id);
    const b = await newTask();
    expect(await pipeline.start(b.id)).toMatchObject({ state: "triage", queued: true });
    await settle();
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });

    // Another stage is not held by triage's cap: c reaches implementing (and holds there) with its own slot.
    await db.query("update tasks set state = 'implementing', queued = true, queued_at = now() where id = $1", [(await newTask()).id]);
    await pipeline.tick();
    await settle();
    expect((await pipeline.list()).filter((t) => t.state === "implementing" && !t.queued)).toHaveLength(1);
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: true });

    // Triage's slot frees: b goes.
    await pipeline.abort(a.id);
    await until(async () => !(await pipeline.get(b.id)).queued, "b to be claimed");
    expect(await pipeline.get(b.id)).toMatchObject({ state: "triage", queued: false });
    await pipeline.shutdown();
  });

  it("parks a task between stages when its next stage is at cap, and the supervisor picks it up later", async () => {
    // The first test_design holds its slot until aborted; later ones pass.
    let held = 0;
    const holdOnce: StageRunner = (context) => (held++ === 0 ? holding(context) : Promise.resolve({ outcome: "pass" }));
    const runnerFor = (stage: TaskState) => (stage === "test_design" ? holdOnce : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { inline: true, maxConcurrentTasks: 4, maxPerStage: { test_design: 1 } });
    const b = await newTask();
    await pipeline.start(b.id);
    // a is parked at test_design (inline, so after b's start: a loop's end fills the queue).
    const a = await newTask();
    await db.query("update tasks set state = 'test_design', queued = true, queued_at = now() where id = $1", [a.id]);
    // a takes test_design's one slot (and holds); b, approved, is parked before test_design.
    const ticked = pipeline.tick();
    await settle();
    expect(await pipeline.decide(b.id, "approved")).toMatchObject({ state: "test_design", queued: true });
    expect((await pipeline.events(b.id)).map((e) => e.kind)).toContain("stage.held");
    await pipeline.abort(a.id);
    await ticked;
    await pipeline.tick();
    expect(await pipeline.get(b.id)).toMatchObject({ state: "awaiting_test_check", queued: false });
  });

  it("reads MACHINE_MAX_PER_STAGE as stage=n pairs", () => {
    expect(loadConfig({ HOME: "/h" }).maxPerStage).toEqual({});
    expect(loadConfig({ HOME: "/h", MACHINE_MAX_PER_STAGE: "implementing=2, e2e=1" }).maxPerStage).toEqual({ implementing: 2, e2e: 1 });
    expect(() => loadConfig({ HOME: "/h", MACHINE_MAX_PER_STAGE: "implementing=0" })).toThrow(/MACHINE_MAX_PER_STAGE/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_MAX_PER_STAGE: "flying=1" })).toThrow(/MACHINE_MAX_PER_STAGE/);
  });

  it("lets a repo's PIPELINE.md cap its own concurrency below the machine's", async () => {
    const runnerFor = (stage: TaskState) => (stage === "triage" ? holding : stubs.runnerFor(stage));
    const policies = { for: async (repoPath: string | null) => ({ ...DEFAULT_POLICY, maxConcurrent: repoPath === "/r/a" ? 1 : null }) };
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 4, policies });
    const a1 = await pipeline.createTask({ title: "a1", repoPath: "/r/a" });
    await pipeline.start(a1.id);
    const a2 = await pipeline.createTask({ title: "a2", repoPath: "/r/a" });
    expect((await pipeline.start(a2.id)).queued).toBe(true);
    const b1 = await pipeline.createTask({ title: "b1", repoPath: "/r/b" });
    expect((await pipeline.start(b1.id)).queued).toBe(false);
    await settle();
    expect((await pipeline.get(a2.id)).queued).toBe(true);
    await pipeline.shutdown();
  });
});

describe("ci_watch outside the pool", () => {
  /** A ci_watch that polls until told the checks are green. */
  let green: (() => void) | undefined;
  const polling: StageRunner = () => new Promise<StageResult>((resolve) => { green = () => resolve({ outcome: "pass" }); });
  const holding: StageRunner = ({ signal }) =>
    new Promise<StageResult>((resolve) => signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true }));
  beforeEach(() => {
    green = undefined;
  });

  it("gives the slot back while polling, and takes one again (or queues) for the stage after", async () => {
    const runnerFor = (stage: TaskState) => (stage === "ci_watch" ? polling : stage === "triage" ? holding : stubs.runnerFor(stage));
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 1 });
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
  });
});

describe("re-attaching to a container after a restart", () => {
  const running = (id: string, container: string) =>
    db
      .query("update tasks set state = 'implementing', queued = false, updated_at = now() - interval '5 minutes' where id = $1", [id])
      .then(() =>
        db.query(
          `insert into stage_runs (task_id, stage, attempt, status, container_id, input_commit, started_at)
           values ($1, 'implementing', 1, 'running', $2, 'abc123', now() - interval '5 minutes')`,
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
    const restarted = new Pipeline(db, runnerFor, { inline: true, containerRunning: async (name) => name === "hardness-c1" });
    expect(await restarted.recover()).toBe(0);
    expect(resumed).toEqual({ container: "hardness-c1", inputCommit: "abc123" });
    expect((await restarted.get(task.id)).state).toBe("awaiting_ship");
    const runs = await restarted.stageRuns(task.id);
    expect(runs.filter((r) => r.stage === "implementing")).toMatchObject([{ attempt: 1, status: "passed", containerId: "hardness-c1" }]);
    expect((await restarted.events(task.id)).map((e) => e.kind)).toContain("stage.reattached");
  });

  it("still escalates when the container is gone", async () => {
    const task = await newTask();
    await running(task.id, "hardness-c1");
    const restarted = new Pipeline(db, stubs.runnerFor, { inline: true, containerRunning: async () => false });
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
    pipeline = new Pipeline(db, runnerFor, { inline: true });
    await pipeline.start(task.id);
    expect((await pipeline.stageRuns(task.id))[0]).toMatchObject({ containerId: "hardness-t1", inputCommit: "def456", status: "passed" });
  });
});

describe("restart policy", () => {
  /** A stage that runs until the machine stops it, the way a real container does. */
  const untilAborted: StageRunner = ({ signal }) =>
    new Promise<StageResult>((resolve) => signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true }));
  let reached = 0;
  const counting: StageRunner = (context) => {
    reached++;
    return untilAborted(context);
  };
  const runnerFor = (stage: TaskState) => (stage === "triage" ? counting : stubs.runnerFor(stage));

  it("parks running tasks in the queue on shutdown, so a restart resumes them with no approval", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 1 });
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

    const restarted = new Pipeline(db, stubs.runnerFor, { inline: true });
    expect(await restarted.recover()).toBe(0);
    expect((await restarted.get(a.id)).state).toBe("awaiting_approval");
    expect((await restarted.get(b.id)).state).toBe("awaiting_approval");
  });

  it("escalates them instead under the escalate policy, as before", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { restartPolicy: "escalate" });
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

describe("drain and slots", () => {
  const holding: StageRunner = ({ signal }) =>
    new Promise<StageResult>((resolve) => signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true }));
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
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 2 });
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await pipeline.get(b.id)).queued).toBe(false);
    expect(reached).toBe(2);
  });

  it("slots can be resized at run time; a smaller pool queues new work, a larger one fills", async () => {
    reached = 0;
    pipeline = new Pipeline(db, runnerFor, { maxConcurrentTasks: 1 });
    const a = await newTask();
    await pipeline.start(a.id);
    while (reached < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await newTask();
    expect((await pipeline.start(b.id)).queued).toBe(true);
    expect(pipeline.setSlots(2)).toMatchObject({ max: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    const blocking: StageRunner = () =>
      new Promise<StageResult>((resolve) => {
        finishFirst = () => resolve({ outcome: "pass" });
      });
    pipeline = new Pipeline(db, (stage) => (stage === "triage" ? blocking : stubs.runnerFor(stage)), {
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
    while ((await pipeline.get(a.id)).state === "triage") {
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

    while ((await pipeline.get(a.id)).state === "triage" || (await pipeline.get(b.id)).state === "triage") {
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
      inline: true,
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

