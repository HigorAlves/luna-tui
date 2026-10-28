// The ticket popup's routes: editing the plan and the cases at their gates, and the branch's diff.
import type { TaskDiff } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { NoWorktreeError } from "../git/diff.ts";
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
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
});

const taskDiff = async (worktreePath: string, repoPath: string | null, file?: string): Promise<TaskDiff> => {
  diffs.push({ worktreePath, repoPath, file });
  if (worktreePath.endsWith("gone")) throw new NoWorktreeError(worktreePath);
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
  it("replaces the cases at the test check and answers the task", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { summary: "s", cases: [{ title: "old", criterion: "c", approach: "a" }] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    const cases = [{ title: "new", criterion: "c", approach: "a2" }];

    const edited = await call(`/tasks/${task.id}/cases`, json({ cases }));
    expect(edited).toMatchObject({ status: 200, body: { id: task.id, state: "awaiting_test_check" } });
    const detail = await call(`/tasks/${task.id}`);
    const approvals = detail.body.approvals as Array<{ kind: string; requested: Record<string, unknown> }>;
    expect(approvals.find((a) => a.kind === "awaiting_test_check")?.requested).toMatchObject({ summary: "s", cases });
  });

  it("is 409 no_cases away from the test check, and 400 for a malformed case", async () => {
    const task = await newTask();
    await pipeline.start(task.id);
    const early = await call(`/tasks/${task.id}/cases`, json({ cases: [{ title: "t", criterion: "c", approach: "a" }] }));
    expect(early).toMatchObject({ status: 409, body: { error: "no_cases" } });
    const bad = await call(`/tasks/${task.id}/cases`, json({ cases: [{ title: "t" }] }));
    expect(bad.status).toBe(400);
  });
});

describe("PATCH /tasks/:id/plan at the test check", () => {
  it("edits the approved plan once the test check is open", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { brief: "b", criteria: ["c1"], assumptions: [] } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");

    const edited = await call(`/tasks/${task.id}/plan`, json({ criteria: ["c1", "c2"] }));
    expect(edited).toMatchObject({ status: 200, body: { state: "awaiting_test_check", criteria: ["c1", "c2"] } });
  });
});

describe("GET /tasks/:id/diff", () => {
  it("answers the branch's files, and one file's patch with ?file=", async () => {
    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/x" } });
    const task = await newTask();
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
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

  it("is 404 no_worktree for a task with no worktree, or whose worktree is gone", async () => {
    const task = await newTask();
    expect(await call(`/tasks/${task.id}/diff`)).toMatchObject({ status: 404, body: { error: "no_worktree" } });

    stubs.plan("implementing", { outcome: "pass", workspace: { branch: "task/x", worktreePath: "/wt/gone" } });
    const built = await newTask();
    await pipeline.start(built.id);
    await pipeline.decide(built.id, "approved");
    await pipeline.decide(built.id, "approved");
    expect(await call(`/tasks/${built.id}/diff`)).toMatchObject({ status: 404, body: { error: "no_worktree" } });
  });
});
