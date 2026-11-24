// The ticket popup's routes: editing the plan and the cases at their gates, and the branch's diff.
import type { TaskDiff } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { NoFileError, NoWorktreeError } from "../git/diff.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
const diffs: Array<{ worktreePath: string; repoPath: string | null; file: string | undefined }> = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  diffs.length = 0;
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});

const taskDiff = async (worktreePath: string, repoPath: string | null, file?: string): Promise<TaskDiff> => {
  diffs.push({ worktreePath, repoPath, file });
  if (worktreePath.endsWith("gone")) throw new NoWorktreeError(worktreePath);
  if (worktreePath.endsWith("broken")) throw new Error("git diff failed: fatal: bad object");
  if (file !== undefined && file !== "a.ts") throw new NoFileError(file);
  return { base: "b", head: "h", files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }], ...(file ? { patch: `patch of ${file}` } : {}) };
};
const app = () => createApp({ db, pipeline, bus: new Bus(), taskDiff });
const json = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const call = async (path: string, init?: RequestInit) => {
  const response = await app().request(path, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const newTask = () => pipeline.createTask({ title: "Login page", criteria: ["Bad password shows an error"] });

describe("PATCH /tasks/:id/cases", () => {
  it("replaces the scenarios on the plan gate and answers the task, keeping the rest of the plan", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", cases: [{ title: "old", criterion: "c", approach: "a" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    const cases = [{ title: "new", criterion: "c", approach: "a2" }];

    const edited = await call(`/tasks/${task.id}/cases`, json({ cases }));
    expect(edited).toMatchObject({ status: 200, body: { id: task.id, state: "awaiting_approval" } });
    const detail = await call(`/tasks/${task.id}`);
    const approvals = detail.body.approvals as Array<{ kind: string; requested: Record<string, unknown> }>;
    expect(approvals.find((a) => a.kind === "awaiting_approval")?.requested).toMatchObject({ brief: "b", cases });
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "cases.edited").map((e) => e.payload)).toEqual([{ count: 1 }]);
  });

  it("is 409 no_cases away from a gate that carries scenarios, and 400 for a malformed case", async () => {
    stubs.plan("triage", { outcome: "needs_input", detail: { questions: [{ question: "q", recommended: "r" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    const early = await call(`/tasks/${task.id}/cases`, json({ cases: [{ title: "t", criterion: "c", approach: "a" }] }));
    expect(early).toMatchObject({ status: 409, body: { error: "no_cases" } });
    const bad = await call(`/tasks/${task.id}/cases`, json({ cases: [{ title: "t" }] }));
    expect(bad.status).toBe(400);
  });
});

describe("PATCH /tasks/:id/plan at the plan gate", () => {
  it("edits the plan the one gate shows", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [] } });
    const task = await newTask();
    await pipeline.start(task.id);

    const edited = await call(`/tasks/${task.id}/plan`, json({ criteria: ["c1", "c2"] }));
    expect(edited).toMatchObject({ status: 200, body: { state: "awaiting_approval" } });
    const detail = await call(`/tasks/${task.id}`);
    const approvals = detail.body.approvals as Array<{ kind: string; requested: Record<string, unknown> }>;
    expect(approvals.find((a) => a.kind === "awaiting_approval")?.requested).toMatchObject({ criteria: ["c1", "c2"] });
  });

  it("finishes every one of more concurrent edits on one task than the pool has connections", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [] } });
    const task = await newTask();
    await pipeline.start(task.id);
    const { max } = (db.driver as unknown as { options: { extra: { max: number } } }).options.extra;
    const edits = Array.from({ length: max + 8 }, (_, i) => call(`/tasks/${task.id}/plan`, json({ brief: `b${i}` })));
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the edits deadlocked on the pool")), 10_000);
    });
    const answers = await Promise.race([Promise.all(edits), stalled]).finally(() => clearTimeout(timer));
    expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: max + 8 }, () => 200));
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "plan.edited")).toHaveLength(max + 8);
  }, 20_000);
});

describe("GET /tasks/:id/diff", () => {
  it("answers the branch's files, and one file's patch with ?file=", async () => {
    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");

    const all = await call(`/tasks/${task.id}/diff`);
    expect(all).toMatchObject({ status: 200, body: { base: "b", head: "h", files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }] } });
    expect(all.body).not.toHaveProperty("patch");
    const one = await call(`/tasks/${task.id}/diff?file=a.ts`);
    expect(one.body).toMatchObject({ patch: "patch of a.ts" });
    expect(diffs).toEqual([
      { worktreePath: "/wt/x", repoPath: null, file: undefined },
      { worktreePath: "/wt/x", repoPath: null, file: "a.ts" },
    ]);
  });

  it("is 404 no_file when ?file= names a path the diff does not have", async () => {
    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    for (const file of ["b.ts", "..", "*"]) {
      expect(await call(`/tasks/${task.id}/diff?file=${encodeURIComponent(file)}`)).toMatchObject({ status: 404, body: { error: "no_file" } });
    }
  });

  it("is 500 internal when git itself fails", async () => {
    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/broken" } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    expect(await call(`/tasks/${task.id}/diff`)).toMatchObject({ status: 500, body: { error: "internal" } });
  });

  it("is 404 no_worktree for a task with no worktree, or whose worktree is gone", async () => {
    const task = await newTask();
    expect(await call(`/tasks/${task.id}/diff`)).toMatchObject({ status: 404, body: { error: "no_worktree" } });

    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/gone" } });
    const built = await newTask();
    await pipeline.start(built.id);
    await pipeline.decide(built.id, "approved");
    expect(await call(`/tasks/${built.id}/diff`)).toMatchObject({ status: 404, body: { error: "no_worktree" } });
  });
});

describe("PATCH /tasks/:id/record", () => {
  const record = { source: "manual", kind: "bug", goal: "g", size: "S", urgency: "P2", risk: "low", signals: {}, qa: [], decision: "plan", reason: "r", at: "2026-11-05T00:00:00.000Z", model: "m", typeOfWork: "backend", riskPrelim: "low", urgencyDetail: { priority: "P2", subScores: { who: 2, what: 2, impact: 2, time: 1, demand: 1 } }, version: 1, decisionBy: "machine" };
  const atGate = async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [] } });
    const task = await newTask();
    await db.query("update tasks set record = $1 where id = $2", [JSON.stringify(record), task.id]);
    await pipeline.start(task.id);
    await db.query("update tasks set record = $1 where id = $2", [JSON.stringify(record), task.id]);
    return task;
  };

  it("corrects the record at a gate: the version rises and the fields are the person's", async () => {
    const task = await atGate();
    const edited = await call(`/tasks/${task.id}/record`, json({ kind: "feature", riskPrelim: "high" }));
    expect(edited).toMatchObject({ status: 200, body: { record: { kind: "feature", riskPrelim: "high", version: 2, decisionBy: "person", editedFields: ["kind", "riskPrelim"] } } });
  });

  it("takes enum values only: 400 for a made-up one, a free-text field, an unknown key or nothing at all", async () => {
    const task = await atGate();
    for (const body of [{ kind: "epic" }, { size: "XXL" }, { priority: "P9" }, { goal: "rewrite everything" }, { kind: "bug", extra: 1 }, {}]) {
      expect((await call(`/tasks/${task.id}/record`, json(body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("is 409 record_locked away from triage's questions and the plan gate, even while a person is asked", async () => {
    const task = await atGate();
    await db.query("update tasks set state = 'escalated' where id = $1", [task.id]);
    expect(await call(`/tasks/${task.id}/record`, json({ kind: "feature" }))).toMatchObject({ status: 409, body: { error: "record_locked" } });
  });

  it("is 409 record_locked when the card is not at a gate or has no record", async () => {
    const bare = await newTask();
    expect(await call(`/tasks/${bare.id}/record`, json({ kind: "bug" }))).toMatchObject({ status: 409, body: { error: "record_locked" } });
  });
});

describe("POST /tasks/:id/questions/post", () => {
  const post = (id: string) => call(`/tasks/${id}/questions/post`, { method: "POST" });

  it("posts an agent's open questions once, on a tap, and says whether it did", async () => {
    stubs.plan("triage", { outcome: "needs_input", needsInput: [{ question: "Which db?", recommended: "pg" }], detail: { summary: "s" } });
    const task = await newTask();
    await pipeline.start(task.id);
    expect((await pipeline.events(task.id)).some((e) => e.kind === "task.questions")).toBe(false);
    expect(await post(task.id)).toMatchObject({ status: 200, body: { id: task.id, posted: true } });
    expect(await post(task.id)).toMatchObject({ status: 200, body: { posted: false } });
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.questions")).toHaveLength(1);
  });

  it("is 409 no_questions away from the questions gate and 409 secret for a question carrying a token", async () => {
    const early = await newTask();
    expect(await post(early.id)).toMatchObject({ status: 409, body: { error: "no_questions" } });
    stubs.plan("triage", { outcome: "needs_input", needsInput: [{ question: `Is ${["ghp", "a".repeat(36)].join("_")} yours?`, recommended: null }], detail: { summary: "s" } });
    const leaky = await newTask();
    await pipeline.start(leaky.id);
    expect(await post(leaky.id)).toMatchObject({ status: 409, body: { error: "secret" } });
  });
});
