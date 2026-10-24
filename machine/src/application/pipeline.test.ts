import type { TaskState } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NO_RETRIES, TransitionError } from "../domain/transition.ts";
import type { StageResult, StageRunner } from "./ports.ts";
import { StubStages } from "./stages/stubs.ts";
import { freshTestDatabase } from "../test/database.ts";
import { Pipeline, TaskNotFoundError } from "./pipeline.ts";
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

/** A task past backlog, ready for `pipeline.start()` to run triage. */
const newTask = async () => {
  const task = await pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
  return pipeline.start(task.id);
};

/** Starts a task and approves the plan and the test names, which reaches the implementer. */
async function startAndApprove(id: string) {
  await pipeline.start(id);
  await pipeline.decide(id, "approved");
  return pipeline.decide(id, "approved");
}

const stagesRun = async (id: string): Promise<TaskState[]> =>
  (await pipeline.stageRuns(id)).map((run) => run.stage);

describe("creating and starting", () => {
  it("creates a backlog task with an empty retry budget", async () => {
    const task = await pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    expect(task).toMatchObject({ state: "backlog", retries: NO_RETRIES, resumeTo: null });
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

  it("moves a backlog task to intake on start, without running a stage", async () => {
    const task = await pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    const started = await pipeline.start(task.id);
    expect(started.state).toBe("draft");
    expect(await pipeline.stageRuns(task.id)).toEqual([]);
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
        orcStateBin: null,
        watcher: { close: async (id) => void seen.push(id) },
      },
    });
    const created = await closing.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });
    await closing.start(created.id);
    await closing.start(created.id);
    for (let i = 0; i < 4; i++) await closing.decide(created.id, "approved");

    expect((await closing.get(created.id)).state).toBe("closed");
    const event = (await closing.events(created.id)).find((e) => e.kind === "task.closed");
    const report = event?.payload as unknown as CloseReport;
    expect(report.steps.map((s) => s.step)).toEqual(["orc-state", "watch-tab", "worktree"]);
    expect(seen).toEqual([created.id]);
  });

  it("logs a failed step instead of failing the approval", async () => {
    const closing = new Pipeline(db, stubs.runnerFor, {
      inline: true,
      closeDeps: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreeRemove: false,
        orcStateBin: null,
        watcher: { close: async () => Promise.reject(new Error("herdr down")) },
      },
    });
    const created = await closing.createTask({ title: "Login page", criteria: ["x"] });
    await closing.start(created.id);
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
      closeDeps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreeRemove: false, orcStateBin: null },
    });

  async function toMemoryGate(p: Pipeline) {
    // reviewing_memory is a gate; the retro runs inside shipping and its rules ride on the gate.
    stubs.plan("shipping", { outcome: "pass", detail: { rules: { markdown: "- r\n" } } });
    const created = await p.createTask({ title: "Login page", criteria: ["x"] });
    await p.start(created.id);
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
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toEqual(["task.created", "transition"]);
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
      events: [{ at: "2026-01-01T00:00:00Z", kind: "tool", payload: { name: "Read" } }, { at: "t", kind: "orc.note", payload: {} }],
      artifacts: [{ kind: "report", path: "/tmp/r.md", label: "R", sha256: "abc" }],
      usage: { turns: 4, costUsd: 0.25 },
    });
    await pipeline.start(task.id);

    const kinds = (await pipeline.events(task.id)).map((e) => e.kind);
    expect(kinds).toContain("orc.tool");
    expect(kinds).toContain("orc.note");
    expect(kinds).not.toContain("orc.orc.note");
    const [run] = await pipeline.stageRuns(task.id);
    const tool = (await pipeline.events(task.id)).find((e) => e.kind === "orc.tool");
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

