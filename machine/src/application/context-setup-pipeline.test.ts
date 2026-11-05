// A card that starts has its repository, project, owners and history resolved by the machine, and a later correction by a person is kept.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cardOf } from "../domain/card-fields.ts";
import { freshTestDatabase } from "../test/database.ts";
import type { ContextDeps } from "./context-setup.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
const stubs = new StubStages();

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
});

const context: ContextDeps = {
  resolveRepo: async (slug) => (slug === "o/a" ? "/repos/a" : null),
  channelRepo: () => null,
  projectRepo: () => null,
  configProject: async () => null,
  owners: async () => ["@team-a"],
  history: async () => [{ author: "u", text: "it breaks\nevery time" }],
};
const make = (deps: ContextDeps | null = context) => new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, ...(deps ? { contextSetup: deps } : {}) });
const source = { kind: "github", repo: "o/a", number: 4, url: "https://github.com/o/a/issues/4" } as const;

describe("starting a card resolves its context", () => {
  it("stores the repository, owners and history on the card and says so on the timeline", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "Checkout fails", source });
    await pipeline.start(task.id);
    const row = await pipeline.get(task.id);
    expect(row.repoPath).toBe("/repos/a");
    const card = cardOf(row);
    expect(card.owners).toEqual(["@team-a"]);
    expect(card.history).toEqual([{ author: "u", text: "it breaks every time", at: null }]);
    expect(card.resolved).toMatchObject({ repoPath: "/repos/a", project: null });
    expect((await pipeline.events(task.id)).find((e) => e.kind === "context.resolved")?.payload).toEqual({ repoFrom: "map", project: null, owners: 1, history: 1 });
  });

  it("starts as before when no context setup is configured", async () => {
    const pipeline = make(null);
    const task = await pipeline.createTask({ title: "Checkout fails", source });
    await pipeline.start(task.id);
    expect((await pipeline.get(task.id)).repoPath).toBeNull();
  });

  it("keeps a person's change of the repository as ground truth against what was resolved", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "Checkout fails", source });
    await pipeline.start(task.id);
    await pipeline.update(task.id, { repoPath: "/repos/b" }).catch(() => null);
    const events = await pipeline.events(task.id);
    const kept = events.find((e) => e.kind === "context.corrected");
    expect(kept?.payload).toEqual({ corrections: [{ field: "repoPath", resolved: "/repos/a", chosen: "/repos/b" }] });
  });
});
