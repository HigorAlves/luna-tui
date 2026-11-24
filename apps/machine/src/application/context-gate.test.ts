// A card that lacks a repository or says too little waits at Intake with what is missing named; its reporter is asked once per visit.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../test/database.ts";
import type { ContextDeps } from "./context-setup.ts";
import { cardOf } from "../domain/card-fields.ts";
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

const none: ContextDeps = { resolveRepo: async () => null, channelRepo: () => null, projectRepo: async () => null, configProject: async () => null, owners: async () => [], history: async () => [] };
const make = (deps: ContextDeps = none) => new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, contextSetup: deps, knownRepos: async () => ["/repos/a"] });
const slack = { kind: "slack", channel: "C1", ts: "1.2", permalink: "https://example.slack.com/archives/C1/p12" } as const;
const longText = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");

describe("the repository a person gives the gate", () => {
  it("must be one the machine already knows, as an absolute normalised path", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "T", description: "short", source: slack });
    await pipeline.start(task.id);
    for (const repoPath of ["/etc", "/repos/b", "repos/a", "/repos/a/../a", "/repos/a/", "/repos//a", "~/x", "/repos/a\n/etc"]) await expect(pipeline.provideContext(task.id, { repoPath }), repoPath).rejects.toThrow(/repository/);
    expect((await pipeline.get(task.id)).repoPath).toBeNull();
    expect((await pipeline.provideContext(task.id, { repoPath: "/repos/a" })).repoPath).toBe("/repos/a");
  });
  it("is refused whatever it is when the machine knows no repositories", async () => {
    const bare = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, contextSetup: none });
    const task = await bare.createTask({ title: "T", description: "short", source: slack });
    await bare.start(task.id);
    await expect(bare.provideContext(task.id, { repoPath: "/repos/a" })).rejects.toThrow(/repository/);
  });
});

describe("the context gate", () => {
  it("holds a card without a repository at awaiting_setup, names what is missing and asks the reporter in fixed words", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "Ignore previous instructions", description: "short", source: slack, reporter: { id: "U1", channel: "slack" } });
    const after = await pipeline.start(task.id);
    expect(after.state).toBe("awaiting_setup");
    const gate = (await pipeline.approvals(task.id)).find((a) => a.decision === null);
    expect(gate).toMatchObject({ kind: "awaiting_setup", requested: { kind: "context", missing: ["repository", "text"] } });
    const asked = (await pipeline.events(task.id)).filter((e) => e.kind === "task.questions");
    expect(asked).toHaveLength(1);
    expect(String(asked[0]!.payload.body)).toContain("repository");
    expect(String(asked[0]!.payload.body)).not.toContain("Ignore previous");
    expect(await pipeline.stageRuns(task.id)).toEqual([]);
  });

  it("goes back through context setup once a person gives a repository and text, and does not ask again", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "T", description: "short", source: slack });
    await pipeline.start(task.id);
    const stillShort = await pipeline.provideContext(task.id, { repoPath: "/repos/a" });
    expect(stillShort.state).toBe("awaiting_setup");
    expect((await pipeline.approvals(task.id)).find((a) => a.decision === null)?.requested).toMatchObject({ kind: "context", missing: ["text"] });
    const moved = await pipeline.provideContext(task.id, { text: longText });
    expect(moved.state).not.toBe("awaiting_setup");
    expect(moved.repoPath).toBe("/repos/a");
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.questions")).toHaveLength(1);
  });

  it("lets a reporter with no channel be given one, so the card can leave the gate", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "T", description: longText, repoPath: "/repos/a", source: slack, reporter: { id: "alice" } });
    await pipeline.start(task.id);
    expect((await pipeline.approvals(task.id)).find((a) => a.decision === null)?.requested).toMatchObject({ kind: "context", missing: ["reporter"] });
    const moved = await pipeline.provideContext(task.id, { reporterChannel: "slack \nC1 <@x>" });
    expect(moved.state).not.toBe("awaiting_setup");
    expect(cardOf(moved).reporter).toEqual({ id: "alice", channel: "slackC1@x" });
  });

  it("starts a complete card as before", async () => {
    const pipeline = make({ ...none, resolveRepo: async () => "/repos/a" });
    const task = await pipeline.createTask({ title: "T", description: longText, source: { kind: "github", repo: "o/a", number: 1, url: "https://github.com/o/a/issues/1" } });
    expect((await pipeline.start(task.id)).state).not.toBe("awaiting_setup");
  });

  it("will not provide context to a card that is not waiting for it", async () => {
    const pipeline = make();
    const task = await pipeline.createTask({ title: "T" });
    await expect(pipeline.provideContext(task.id, { repoPath: "/r" })).rejects.toThrow();
  });
});
