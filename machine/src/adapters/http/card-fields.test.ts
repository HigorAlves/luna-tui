// `POST /tasks` stores what the entry contract carries and `GET /tasks/:id` returns it; a row from before reads as one source.
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

const app = () => createApp({ db, pipeline, bus: new Bus() });
const post = async (body: unknown) => {
  const response = await app().request("/tasks", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const get = async (id: string) => ((await (await app().request(`/tasks/${id}`)).json()) as { task: Record<string, any> }).task;

describe("a card keeps what create_card carries", () => {
  it("stores and returns the sources, reporter, hints, attachments, project, owners and followers", async () => {
    const created = await post({
      title: "Login page",
      source: { kind: "github", repo: "o/a", number: 1, url: "https://github.com/o/a/issues/1" },
      sources: [{ type: "slack", permalink: "https://example.slack.com/archives/C1/p1" }],
      reporter: { id: "U1", channel: "slack" },
      hints: { urgency: "high", confidence: 0.8 },
      originMachine: "conversation",
      attachments: [{ name: "trace.txt", url: "https://files.example/t.txt", size: 10 }],
      project: "PAY",
      owners: ["@team-a"],
      followers: ["U2"],
    });
    expect(created.status).toBe(201);
    const task = await get(created.body.id);
    expect(task.source).toMatchObject({ kind: "github", number: 1 });
    expect(task.sources).toHaveLength(2);
    expect(task.sources[0]).toMatchObject({ kind: "github" });
    expect(task).toMatchObject({
      reporter: { id: "U1", channel: "slack" },
      hints: { urgency: "high", confidence: 0.8 },
      originMachine: "conversation",
      attachments: [{ name: "trace.txt", url: "https://files.example/t.txt", size: 10 }],
      project: "PAY",
      owners: ["@team-a"],
      followers: ["U2"],
    });
  });

  it("reads a row written before this wave as one source and empty lists", async () => {
    const source = { kind: "jira", key: "EX-1", url: "https://example.atlassian.net/browse/EX-1", issueType: "Bug" } as const;
    const row = await pipeline.createTask({ title: "Old", source });
    await db.query("update tasks set card = null where id = $1", [row.id]);
    expect(await get(row.id)).toMatchObject({ sources: [source], reporter: null, hints: null, attachments: [], owners: [], followers: [], project: null });
  });

  it("appends a second source and never changes the first", async () => {
    const first = { kind: "github", repo: "o/a", number: 1, url: "https://github.com/o/a/issues/1" } as const;
    const row = await pipeline.createTask({ title: "T", source: first });
    const second = { kind: "slack", channel: "C1", ts: "1.2", permalink: "https://example.slack.com/archives/C1/p12" } as const;
    await pipeline.addSource(row.id, second);
    await pipeline.addSource(row.id, second);
    await pipeline.addSource(row.id, { kind: "github", repo: "o/b", number: 9, url: "u" });
    const task = await get(row.id);
    expect(task.sources).toEqual([first, second, { kind: "github", repo: "o/b", number: 9, url: "u" }]);
    expect(task.source).toEqual(first);
  });
});
