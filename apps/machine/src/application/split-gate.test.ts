// The split gate (wave 15, slice 4): a plan over the size limit waits for a person with a proposal. Nothing is made before
// a person approves a split (slice 5): the loop, the clock and a retry make no card; keeping the card whole is a person's
// recorded answer; the gate refuses an approval that cannot yet make anything.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NoCasesToEditError, NoPlanToEditError, Pipeline, RejectNotAllowedError } from "./pipeline.ts";
import type { StageContext, StageResult } from "./ports.ts";
import { StubStages } from "./stages/stubs.ts";
import { PREVIEW_ON, previewOn } from "../test/policies.ts";
import { freshTestDatabase } from "../test/database.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
const seen: Array<{ stage: string; approvals: StageContext["approvals"] }> = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
const runner = (stage: Parameters<StubStages["runnerFor"]>[0]) => {
  const inner = stubs.runnerFor(stage);
  return async (context: StageContext) => (seen.push({ stage, approvals: context.approvals }), inner(context));
};
beforeEach(async () => {
  await pipeline?.shutdown();
  await db.query("truncate tasks cascade");
  stubs.reset();
  seen.length = 0;
  pipeline = new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true });
});

const child = (n: number) => ({ title: `Part ${n}`, goal: "do part", acceptance_criteria: ["works"], covers: [`C${n}`], files_hint: [], est_loc: 400, depends_on: [], order: n });
const over = { verdict: "over", estLoc: 4000, planned: null, limit: { target: [1000, 2000], hard: 2500 }, by: "decision" };
const splitGate = (outcome: "split" | "split_failed" = "split", extra: Record<string, unknown> = {}): StageResult => ({
  outcome: "pass",
  detail: {
    outcome,
    summary: "over the size limit",
    ...(outcome === "split_failed" ? { reason: "no valid split after 3 rounds", split: { children: [], issues: ["criterion C2 is covered by no child"], rounds: 3 } } : { split: { children: [child(1), child(2)], rounds: 1, judged: true, via: "cards" } }),
    size: over,
    flagged: ["over the size limit"],
    decisions: { size_estimate: "rec-size", split_check: "rec-split" },
    ...extra,
  },
});
const atGate = async (outcome: "split" | "split_failed" = "split", extra: Record<string, unknown> = {}) => {
  stubs.plan("test_design", splitGate(outcome, extra));
  const task = await pipeline.createTask({ title: "Everything", criteria: ["csv", "pdf"] });
  await pipeline.start(task.id);
  return task.id;
};
const count = async (table: string): Promise<number> => Number((await db.query(`select count(*)::int as n from ${table}`))[0].n);

describe("a plan over the size limit", () => {
  it("waits at the plan gate with the split, and starts no Build", async () => {
    const id = await atGate();
    expect((await pipeline.get(id)).state).toBe("awaiting_approval");
    const [gate] = await pipeline.approvals(id);
    expect(gate).toMatchObject({ kind: "awaiting_approval", decision: null, requested: { outcome: "split", split: { via: "cards" } } });
    expect((await pipeline.stageRuns(id)).map((r) => r.stage)).not.toContain("implementing");
  });

  it("makes no card and no ticket by itself: the loop's end, a clock that approves plans and a retry leave one card and the gate open", async () => {
    pipeline = new Pipeline(db, runner, { inline: true, hasConfig: () => true, policies: { for: async () => ({ ...PREVIEW_ON, autoApprovePlanMinutes: 1 }) } });
    for (const outcome of ["split", "split_failed"] as const) {
      await db.query("truncate tasks cascade");
      stubs.reset();
      // As confident as a plan can be: low risk, every check proceeding, nothing flagged. Only the outcome keeps the clock off it.
      const id = await atGate(outcome, { flagged: [], risk: { level: "low", scores: {} }, verdicts: { coverage: "proceed", plan: "proceed", risk: "proceed" } });
      await db.query("update approvals set created_at = now() - interval '2 hours'");
      await pipeline.tick();
      await pipeline.tick();
      expect((await pipeline.get(id)).state, outcome).toBe("awaiting_approval");
      expect(await count("tasks"), outcome).toBe(1);
      const kinds = (await pipeline.events(id)).map((e) => e.kind);
      expect(kinds.filter((k) => k.startsWith("card.") || k === "plan.auto_approved"), outcome).toEqual([]);
      expect((await pipeline.approvals(id))[0]!.decision).toBeNull();
    }
  });

  it("refuses an approval that has nothing valid to make: a split that fails the checks now, or no split at all", async () => {
    const id = await atGate("split");
    await expect(pipeline.decide(id, "approved")).rejects.toMatchObject({ name: "SplitNotValidError" });
    const failed = await atGate("split_failed");
    await expect(pipeline.decide(failed, "approved")).rejects.toMatchObject({ name: "SplitNotValidError" });
    expect(await count("tasks")).toBe(2);
    expect((await pipeline.get(id)).state).toBe("awaiting_approval");
    expect((await pipeline.approvals(id))[0]!.decision).toBeNull();
  });

  it("keeps the card whole only when a person says so: the gate closes approved with the answer, size.overridden is logged, and the plan stage runs again", async () => {
    const id = await atGate();
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "whole plan", flagged: ["over the size limit: kept whole by a person"], risk: { level: "low", scores: {} } } });
    const moved = await pipeline.decide(id, "approved", "one change is fine", { keepWhole: true });
    expect(moved.state).toBe("awaiting_approval");
    const gates = await pipeline.approvals(id);
    expect(gates[0]).toMatchObject({ decision: "approved", response: { keepWhole: true } });
    expect(gates[1]).toMatchObject({ decision: null, requested: { brief: "whole plan" } });
    expect(gates[1]!.requested.outcome).toBeUndefined();
    const logged = (await pipeline.events(id)).find((e) => e.kind === "size.overridden");
    expect(logged?.payload).toEqual({ estLoc: 4000, limit: 2500 });
    // The second run of the plan stage is handed the keep-whole among the approvals it reads.
    const second = seen.filter((s) => s.stage === "test_design")[1]!;
    expect(second.approvals.some((a) => a.response?.keepWhole === true && a.decision === "approved")).toBe(true);
    expect(await count("tasks")).toBe(1);
    // That gate is flagged, so a clock never approves it, and a person's approval goes on to Build.
    expect((await pipeline.decide(id, "approved")).state).toBe("awaiting_ship");
  });

  it("never lets keepWhole ride on an ordinary plan gate: only a split gate takes it", async () => {
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", risk: { level: "low", scores: {} } } });
    const task = await pipeline.createTask({ title: "Login" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, { keepWhole: true });
    const [gate] = await pipeline.approvals(task.id);
    expect(gate!.decision).toBe("approved");
    expect(gate!.response ?? {}).not.toHaveProperty("keepWhole");
  });

  it("sends the split back with a comment: the plan stage runs again and reads the comment among the approvals", async () => {
    const id = await atGate();
    stubs.plan("test_design", splitGate("split"));
    const moved = await pipeline.decide(id, "changes_requested", "cut it by layer, not by screen");
    expect(moved.state).toBe("awaiting_approval");
    const gates = await pipeline.approvals(id);
    expect(gates[0]).toMatchObject({ decision: "sent_back", reason: "cut it by layer, not by screen" });
    expect(gates[1]).toMatchObject({ decision: null, requested: { outcome: "split" } });
    const second = seen.filter((s) => s.stage === "test_design")[1]!;
    expect(second.approvals.at(-1)).toMatchObject({ decision: "sent_back", reason: "cut it by layer, not by screen", requested: { outcome: "split" } });
    // A split gate sent back goes to the plan stage, never to triage.
    expect(seen.filter((s) => s.stage === "triage")).toHaveLength(1);
  });

  it("rejects either outcome: the card is archived with reason rejected", async () => {
    for (const outcome of ["split", "split_failed"] as const) {
      await db.query("truncate tasks cascade");
      stubs.reset();
      const id = await atGate(outcome);
      const done = await pipeline.decide(id, "rejected", "not now");
      expect(done, outcome).toMatchObject({ state: "archived", archiveReason: "rejected" });
      expect(await count("tasks")).toBe(1);
    }
    await expect(pipeline.decide("00000000-0000-4000-8000-000000000000", "rejected")).rejects.toBeInstanceOf(Error);
    expect(RejectNotAllowedError).toBeDefined();
  });

  it("has nothing to edit: editPlan and editCases answer their no-such-thing errors", async () => {
    const id = await atGate();
    await expect(pipeline.editPlan(id, { brief: "x" })).rejects.toBeInstanceOf(NoPlanToEditError);
    await expect(pipeline.editCases(id, [])).rejects.toBeInstanceOf(NoCasesToEditError);
  });
});

describe("what a split gate teaches the split_check record", () => {
  const learned: Array<Record<string, unknown>> = [];
  const yes = { covers: { value: true, p: 0.9 }, no_overlap: { value: true, p: 0.9 }, stand_alone: { value: true, p: 0.9 } };
  beforeEach(() => {
    learned.length = 0;
    pipeline = new Pipeline(db, runner, {
      inline: true,
      policies: previewOn,
      hasConfig: () => true,
      truth: { learned: async (fact: Record<string, unknown>) => (learned.push(fact), true), answerOf: async () => yes } as never,
    });
  });

  it("contradicts it when the split is sent back, rejected or kept whole", async () => {
    const back = await atGate();
    stubs.plan("test_design", splitGate());
    await pipeline.decide(back, "changes_requested", "no");
    const rejected = await atGate();
    await pipeline.decide(rejected, "rejected", "no");
    const kept = await atGate();
    stubs.plan("test_design", { outcome: "pass", detail: { brief: "b" } });
    await pipeline.decide(kept, "approved", undefined, { keepWhole: true });
    const splitRows = learned.filter((l) => l.pack === "split_check");
    expect(splitRows).toHaveLength(3);
    for (const row of splitRows) expect(row).toMatchObject({ recordId: "rec-split", label: { covers: { value: false }, no_overlap: { value: false }, stand_alone: { value: false } } });
    expect(splitRows.map((r) => r.source)).toEqual(["split_sent_back", "split_sent_back", "split_kept_whole"]);
  });
});
