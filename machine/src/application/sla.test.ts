import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY } from "../domain/policy.ts";
import { freshTestDatabase } from "../test/database.ts";
import { Pipeline } from "./pipeline.ts";
import { SlaClocks } from "./sla.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

describe("SlaClocks", () => {
  it("times the gate from the transition into it, with the repo's target over the machine's, and sees a flip on the tick", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, policies: { for: async () => ({ ...DEFAULT_POLICY, sla: { gate: 600 } }) } });
    let now = new Date();
    const clocks = new SlaClocks({ pipeline, defaults: { gate: 3600, cycle: null }, now: () => now });
    const task = await pipeline.createTask({ title: "x", repoPath: "/r/a" });
    expect(await clocks.for(task)).toBeNull();
    await pipeline.start(task.id);
    const waiting = await pipeline.get(task.id);
    expect(waiting.state).toBe("awaiting_approval");
    const entered = (await pipeline.events(task.id)).findLast((e) => e.kind === "transition" && e.payload.to === "awaiting_approval")!.at;
    const sla = await clocks.for(waiting);
    expect(sla?.gate).toEqual({ dueAt: new Date(entered.getTime() + 600_000).toISOString(), overdue: false, targetSecs: 600, since: entered.toISOString(), state: "awaiting_approval" });
    expect(sla?.cycle).toBeNull();
    expect(await clocks.flipped([waiting])).toEqual([]);
    now = new Date(entered.getTime() + 601_000);
    const flipped = await clocks.flipped([waiting]);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]!.sla?.gate?.overdue).toBe(true);
    expect(await clocks.flipped([waiting])).toEqual([]);
  });

  it("reads the wait from the row's state_since, and prices a whole board from one stage-run query", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, policies: { for: async () => ({ ...DEFAULT_POLICY, sla: { gate: 600, stage: { implementing: 60 } } }) } });
    const starts = vi.spyOn(pipeline, "runningStageStarts");
    const clocks = new SlaClocks({ pipeline, defaults: { gate: 3600, cycle: null } });
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    const b = await pipeline.createTask({ title: "b", repoPath: "/r/b" });
    expect(a.stateSince).toBeInstanceOf(Date);
    await pipeline.start(a.id);
    const waiting = await pipeline.get(a.id);
    const entered = (await pipeline.events(a.id)).findLast((e) => e.kind === "transition")!.at;
    expect(waiting.stateSince?.toISOString()).toBe(entered.toISOString());
    const all = await clocks.forAll([waiting, b]);
    expect(all.get(a.id)?.gate?.since).toBe(entered.toISOString());
    expect(all.get(b.id)).toBeNull();
    // No task is in a running state: the stage runs were not even asked for.
    expect(starts).not.toHaveBeenCalled();
    const flipped = await clocks.flipped([waiting, b]);
    expect(flipped).toEqual([]);
    expect(starts).not.toHaveBeenCalled();
  });

  it("uses the machine's cycle default and reads the running stage's start for the stage clock", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, policies: { for: async () => ({ ...DEFAULT_POLICY, sla: { stage: { implementing: 60 } } }) } });
    const clocks = new SlaClocks({ pipeline, defaults: { gate: 3600, cycle: 86_400 } });
    const task = await pipeline.createTask({ title: "x", repoPath: "/r/a" });
    const sla = await clocks.for(task);
    expect(sla?.cycle).toMatchObject({ targetSecs: 86_400, overdue: false });
    expect(sla?.gate).toBeNull();
    expect(sla?.stage).toBeNull();
  });
});
