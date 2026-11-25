import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { previewOn } from "../../test/policies.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
const synced: string[][] = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  synced.length = 0;
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: false, policies: previewOn, hasConfig: () => true, syncPrHead: async (...a: string[]) => void synced.push(a) });
});

const call = async (path: string) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(path, { method: "POST" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("POST /tasks/:id/rewatch", () => {
  it("loops a card watching its PR back to its route's first stage, on the PR's head as it is now", async () => {
    const task = await pipeline.createTask({ title: "PR #12", route: "review", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: "https://github.com/o/a/pull/12", headRef: "feat/x", baseRef: "main" } });
    await db.query("update tasks set state = 'pr_watch', worktree_path = '/wt/a/pr-12' where id = $1", [task.id]);
    const done = await call(`/tasks/${task.id}/rewatch`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "reviewing" });
    expect(synced).toEqual([["/r/a", "feat/x", "/wt/a/pr-12"]]);
  });

  it("refuses a card that is not watching its PR with 409 not_watching", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    const refused = await call(`/tasks/${task.id}/rewatch`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "not_watching" });
  });
});
