// The dependency rule at Pipeline.start (wave 15, slice 6): a card with dependencies is held as a draft until each has merged
// or has an open PR, then starts on the branch of the one it stacks on. The pool and the repository's cap are unchanged.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StageResult, StageRunner } from "./ports.ts";
import type { TaskState } from "@hardness/contracts";

import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { previewOn } from "../test/policies.ts";
import { freshTestDatabase } from "../test/database.ts";
import { cardOf } from "../domain/card-fields.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
const make = (options: Record<string, unknown> = {}, runner: (stage: TaskState) => StageRunner = stubs.runnerFor) => new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true, ...options });
beforeEach(async () => {
  await pipeline?.shutdown();
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = make();
});

const REPO = "/r/app";
const parentCard = async (p: Pipeline = pipeline, repoPath = REPO) => {
  const task = await p.createTask({ title: "Parent", criteria: ["c"], repoPath });
  await db.query("update tasks set branch = $2 where id = $1", [task.id, `task/${task.id.slice(0, 8)}-parent`]);
  await p.start(task.id);
  return task.id;
};
/** The parent walks to awaiting_ship: its PR is open. */
const openPr = async (id: string, p: Pipeline = pipeline) => {
  stubs.plan("delivering", { outcome: "pass", detail: { prUrl: "https://github.com/o/a/pull/7", prNumber: 7 } });
  await p.decide(id, "approved");
};
const child = async (dependsOn: string[], p: Pipeline = pipeline, repoPath = REPO) =>
  (await p.createTask({ title: "Child", criteria: ["c"], repoPath, stack: { dependsOn, startWhenReady: true } })).id;
const kinds = async (id: string, p: Pipeline = pipeline) => (await p.events(id)).map((e) => e.kind);
const held = async (id: string) => (await pipeline.events(id)).filter((e) => e.kind === "card.held").map((e) => e.payload);

describe("a card that depends on others", () => {
  it("is held as a draft while its dependency has no open PR, and says what it waits for once", async () => {
    const parent = await parentCard();
    const kid = await child([parent]);
    expect(await pipeline.start(kid)).toMatchObject({ state: "draft" });
    expect(cardOf(await pipeline.get(kid)).startWhenReady).toBe(true);
    expect(await held(kid)).toEqual([{ reason: "waiting", waitingOn: [parent], text: `waiting for ${parent.slice(0, 8)} to have an open PR` }]);
    await pipeline.start(kid);
    expect(await held(kid)).toHaveLength(1);
  });

  it("starts on its parent's branch once the parent has an open PR, and logs the release", async () => {
    const parent = await parentCard();
    const kid = await child([parent]);
    await pipeline.start(kid);
    await openPr(parent);
    await pipeline.releaseHeld();
    const row = await pipeline.get(kid);
    expect(row.state).not.toBe("draft");
    const base = { card: parent, branch: (await pipeline.get(parent)).branch };
    expect(cardOf(row).base).toEqual(base);
    expect((await pipeline.events(kid)).find((e) => e.kind === "card.released")?.payload).toEqual({ base });
  });

  it("starts by itself when the parent's delivering run passes, with no tick and no call", async () => {
    const parent = await parentCard();
    const kid = await child([parent]);
    await pipeline.start(kid);
    await openPr(parent);
    expect((await pipeline.get(kid)).state).not.toBe("draft");
  });

  it("starts with no base when its dependency already merged", async () => {
    const parent = await parentCard();
    await openPr(parent);
    await pipeline.decide(parent, "approved");
    expect((await pipeline.get(parent)).state).toBe("closed");
    const kid = await child([parent]);
    await pipeline.start(kid);
    expect(cardOf(await pipeline.get(kid)).base).toBeUndefined();
    expect((await pipeline.events(kid)).find((e) => e.kind === "card.released")?.payload).toEqual({ base: null });
  });

  it("stays a draft and says so once when its dependency was archived", async () => {
    const parent = await parentCard();
    const kid = await child([parent]);
    await pipeline.start(kid);
    await pipeline.archive(parent, "rejected");
    await pipeline.releaseHeld();
    await pipeline.releaseHeld();
    expect((await pipeline.get(kid)).state).toBe("draft");
    expect(await held(kid)).toEqual([
      { reason: "waiting", waitingOn: [parent], text: `waiting for ${parent.slice(0, 8)} to have an open PR` },
      { reason: "dependency_archived", waitingOn: [parent], text: `${parent.slice(0, 8)} was archived (rejected); a person decides` },
    ]);
  });

  it("is held with `missing` for a dependency that is no card", async () => {
    const kid = await child(["00000000-0000-4000-8000-0000000000aa"]);
    await pipeline.start(kid);
    expect(await held(kid)).toEqual([{ reason: "missing", waitingOn: ["00000000-0000-4000-8000-0000000000aa"], text: "00000000 is not a card" }]);
  });

  it("says a parent that is stopped with a person is stopped with a person, and goes on waiting", async () => {
    const parent = await parentCard();
    const kid = await child([parent]);
    await db.query("update tasks set state = 'escalated' where id = $1", [parent]);
    await pipeline.start(kid);
    expect(await held(kid)).toEqual([{ reason: "waiting", waitingOn: [parent], text: `waiting for ${parent.slice(0, 8)}, which is stopped with a person` }]);
    expect((await pipeline.get(kid)).state).toBe("draft");
  });

  it("takes the old path untouched when it has no dependency: no hold, no release, no base", async () => {
    const task = await pipeline.createTask({ title: "Plain", criteria: ["c"], repoPath: REPO });
    await pipeline.start(task.id);
    const all = await kinds(task.id);
    expect(all.some((k) => k === "card.held" || k === "card.released")).toBe(false);
    expect(cardOf(await pipeline.get(task.id)).base).toBeUndefined();
    expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");
  });

  it("never starts a draft that was not made to wait by itself (no startWhenReady)", async () => {
    const parent = await parentCard();
    await openPr(parent);
    const kid = (await pipeline.createTask({ title: "Manual", criteria: ["c"], repoPath: REPO, stack: { dependsOn: [parent] } })).id;
    await pipeline.releaseHeld();
    expect((await pipeline.get(kid)).state).toBe("draft");
  });

  it("goes through the pool like any card: three released children with a cap of one repository run one at a time", async () => {
    const holding: StageRunner = ({ signal }) =>
      new Promise<StageResult>((resolve) => {
        if (signal.aborted) resolve({ outcome: "fail" });
        else signal.addEventListener("abort", () => resolve({ outcome: "fail" }), { once: true });
      });
    const p = make({ inline: false, maxConcurrentTasks: 4, maxPerRepo: 1 }, (stage) => (stage === "triage" ? holding : stubs.runnerFor(stage)));
    pipeline = p;
    // The parent was walked to its open PR by an inline pipeline on the same database.
    const walker = make();
    const parent = await parentCard(walker);
    await openPr(parent, walker);
    await walker.shutdown();
    const kids = [await child([parent], p, REPO), await child([parent], p, REPO), await child([parent], p, REPO)];
    await p.releaseHeld();
    const rows = await Promise.all(kids.map((k) => p.get(k)));
    expect(rows.filter((r) => r.state === "triage" && !r.queued)).toHaveLength(1);
    expect(rows.filter((r) => r.queued)).toHaveLength(2);
    await p.shutdown();
  });
});

describe("the stack, read and cleared", () => {
  it("finds the open cards stacked on a card, and not the ended ones", async () => {
    const parent = await parentCard();
    await openPr(parent);
    const a = await child([parent]);
    const b = await child([parent]);
    await pipeline.start(a);
    await pipeline.start(b);
    expect((await pipeline.stackedOn(parent)).map((r) => r.id).sort()).toEqual([a, b].sort());
    await pipeline.archive(b, "rejected");
    expect((await pipeline.stackedOn(parent)).map((r) => r.id)).toEqual([a]);
    expect(await pipeline.stackedOn("00000000-0000-4000-8000-0000000000bb")).toEqual([]);
  });

  it("clears the base under the lock and logs the retarget once", async () => {
    const parent = await parentCard();
    await openPr(parent);
    const kid = await child([parent]);
    await pipeline.start(kid);
    expect(cardOf(await pipeline.get(kid)).base?.card).toBe(parent);
    await pipeline.clearBase(kid);
    expect(cardOf(await pipeline.get(kid)).base).toBeUndefined();
    await pipeline.clearBase(kid);
    const retargets = (await pipeline.events(kid)).filter((e) => e.kind === "stack.retargeted");
    expect(retargets.map((e) => e.payload)).toEqual([{ to: "default" }]);
  });
});

describe("what a stacked card's workspace is cut from, read from the rows as they are now", () => {
  it("is null for a card with no base", async () => {
    const task = await pipeline.createTask({ title: "Plain", criteria: ["c"], repoPath: REPO });
    expect(await pipeline.baseOf(task)).toBeNull();
  });

  it("is the parent's branch while its PR is open", async () => {
    const parent = await parentCard();
    await openPr(parent);
    const kid = await child([parent]);
    await pipeline.start(kid);
    expect(await pipeline.baseOf(await pipeline.get(kid))).toEqual({ state: "open", branch: (await pipeline.get(parent)).branch });
  });

  it("is merged once the parent closed, and gone, in fixed words with the reason, once it was archived", async () => {
    const parent = await parentCard();
    await openPr(parent);
    const kid = await child([parent]);
    await pipeline.start(kid);
    await pipeline.archive(parent, "rejected");
    expect(await pipeline.baseOf(await pipeline.get(kid))).toEqual({ state: "gone", reason: `the card this one is stacked on (${parent.slice(0, 8)}) was archived (rejected); it needs a person` });

    const other = await parentCard();
    await openPr(other);
    const kid2 = await child([other]);
    await pipeline.start(kid2);
    await pipeline.decide(other, "approved");
    expect((await pipeline.get(other)).state).toBe("closed");
    expect(await pipeline.baseOf(await pipeline.get(kid2))).toEqual({ state: "merged" });
  });
});
