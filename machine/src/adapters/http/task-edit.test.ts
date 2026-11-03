// `PATCH /tasks/:id`: the ticket's text moves until it is built; where it came from never moves,
// and its checkout cannot move under a worktree already made from it.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
});

const notch = { kind: "notch", ref: "LUNA-14", id: "8f1c0d7e-0000-0000-0000-000000000000" } as const;
const patch = async (id: string, body: unknown) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const withWorktree = (id: string) => db.query("update tasks set worktree_path = '/wt/a', branch = 'task/a' where id = $1", [id]);

describe("PATCH /tasks/:id", () => {
  it("edits a board task's title, description, criteria and checkout as before", async () => {
    const task = await pipeline.createTask({ title: "Login", repoPath: "/r/a" });
    const edited = await patch(task.id, { title: "Login page", description: "d", criteria: ["c"], repoPath: "/r/b" });
    expect(edited).toMatchObject({ status: 200, body: { title: "Login page", description: "d", criteria: ["c"], repoPath: "/r/b" } });
  });

  it("refuses to change where a task came from (400 source_immutable), a notch task or any other", async () => {
    const task = await pipeline.createTask({ title: "Login", source: notch });
    expect(await patch(task.id, { source: { ...notch, ref: "LUNA-15" } })).toMatchObject({ status: 400, body: { error: "source_immutable" } });
    expect(await patch(task.id, { source: null })).toMatchObject({ status: 400, body: { error: "source_immutable" } });
    const board = await pipeline.createTask({ title: "Board" });
    expect(await patch(board.id, { source: notch })).toMatchObject({ status: 400, body: { error: "source_immutable" } });
    expect((await pipeline.get(task.id)).source).toEqual(notch);
    expect((await pipeline.get(board.id)).source).toBeNull();
  });

  it("takes the same source back unchanged, so a client may resend the whole ticket", async () => {
    const task = await pipeline.createTask({ title: "Login", source: notch });
    expect(await patch(task.id, { title: "Login page", source: { id: notch.id, ref: notch.ref, kind: "notch" } })).toMatchObject({ status: 200, body: { title: "Login page" } });
  });

  it("refuses to move the checkout once the task has a worktree (409 has_worktree), and leaves the rest of the edit undone", async () => {
    const task = await pipeline.createTask({ title: "Login", repoPath: "/r/a" });
    await withWorktree(task.id);
    expect(await patch(task.id, { title: "Login page", repoPath: "/r/b" })).toMatchObject({ status: 409, body: { error: "has_worktree" } });
    expect(await pipeline.get(task.id)).toMatchObject({ title: "Login", repoPath: "/r/a" });
    // The board sends the checkout on every edit: the same one is no move.
    expect(await patch(task.id, { title: "Login page", repoPath: "/r/a" })).toMatchObject({ status: 200, body: { title: "Login page" } });
  });
});
