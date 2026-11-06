import { describe, expect, it } from "vitest";

import { type FlowRow, flowMetrics } from "./metrics-query.ts";

const at = (iso: string) => new Date(`2026-11-03T${iso}:00Z`);
const row = (task: string, time: string, kind: string, payload: Record<string, unknown> = {}): FlowRow => ({ task_id: task, kind, payload, at: at(time) });
const finished = (task: string, time: string, stage: string, detail: Record<string, unknown> = {}) => row(task, time, "stage.finished", { stage, status: "passed", detail });
const built = (task: string, time: string) => row(task, time, "stage.started", { stage: "implementing" });
const approved = (task: string, time: string) => row(task, time, "transition", { event: "approved", from: "awaiting_approval", to: "implementing" });

const window: [Date, Date] = [new Date("2026-10-27T00:00:00Z"), new Date("2026-11-03T23:00:00Z")];

describe("flowMetrics", () => {
  const rows: FlowRow[] = [
    // Task A: created 10:00, triaged 10:05, planned in 2 designer rounds, approved 10:35, built twice, merged 12:00.
    row("A", "10:00", "task.created"),
    finished("A", "10:05", "triage"),
    finished("A", "10:10", "test_design", { rounds: { tests: 2, plan: 1 }, cases: [] }),
    approved("A", "10:35"),
    built("A", "10:40"),
    built("A", "11:00"),
    finished("A", "11:30", "implementing"),
    row("A", "12:00", "task.shipped", { number: 1 }),
    // Task B: created 09:00, triaged 09:10, planned in 1 round, approved 09:20, built once, merged 09:30.
    row("B", "09:00", "task.created"),
    finished("B", "09:10", "triage"),
    finished("B", "09:12", "test_design", { rounds: { tests: 1, plan: 1 }, cases: [] }),
    approved("B", "09:20"),
    built("B", "09:21"),
    finished("B", "09:25", "implementing"),
    row("B", "09:30", "ship.merged", { number: 2 }),
    // Task C: triaged and waiting at the plan gate: it adds to nothing.
    row("C", "08:00", "task.created"),
    finished("C", "08:05", "triage"),
    row("C", "08:10", "transition", { event: "stage_done", from: "test_design", to: "awaiting_approval" }),
  ];

  it("reads plan cycle time, coverage rounds, build runs, lead time and merges from the named events", () => {
    const flow = flowMetrics(rows, window);
    // A: 10:05 -> 10:35 = 30 min = 1,800,000 ms; B: 09:10 -> 09:20 = 10 min = 600,000 ms.
    // median of the two = (600,000 + 1,800,000) / 2 = 1,200,000; p90 = 600,000 + (1,800,000 - 600,000) * 0.9 = 1,680,000.
    expect(flow.planCycleMs).toEqual({ median: 1_200_000, p90: 1_680_000, n: 2 });
    // (2 + 1) / 2 rounds
    expect(flow.coverageRounds).toEqual({ value: 1.5, n: 2 });
    // A started the implementer twice, B once: (2 + 1) / 2
    expect(flow.buildRuns).toEqual({ value: 1.5, n: 2 });
    // A: 10:00 -> 12:00 = 7,200,000 ms; B: 09:00 -> 09:30 = 1,800,000 ms; median 4,500,000; p90 = 1,800,000 + 5,400,000 * 0.9 = 6,660,000
    expect(flow.leadTimeMs).toEqual({ median: 4_500_000, p90: 6_660_000, n: 2 });
    // two merges in a window of 7 days and 23 hours: 2 / (191 h / 168 h)
    expect(flow.mergesPerWeek.n).toBe(2);
    expect(flow.mergesPerWeek.value).toBeCloseTo(2 / (191 / 168));
  });

  it("says plainly that a failed change is not recorded", () => {
    const flow = flowMetrics(rows, window);
    expect(flow.changeFailureRate).toEqual({ value: null, n: 0, reason: "nothing records a failed change yet" });
    expect(flow.timeToRestoreMs).toEqual({ value: null, n: 0, reason: "nothing records a failed change yet" });
  });

  it("counts only the tasks whose ending event is in the window", () => {
    const flow = flowMetrics(rows, [new Date("2026-11-03T11:00:00Z"), new Date("2026-11-03T23:00:00Z")]);
    // A's merge (12:00) and build.done (11:30) are inside; its approval (10:35) is before 11:00
    expect(flow.leadTimeMs.n).toBe(1);
    expect(flow.leadTimeMs.median).toBe(7_200_000);
    expect(flow.planCycleMs.n).toBe(0);
    expect(flow.buildRuns).toEqual({ value: 2, n: 1 });
  });

  it("is null, never NaN, with no events", () => {
    const flow = flowMetrics([], window);
    expect(flow.planCycleMs).toEqual({ median: null, p90: null, n: 0 });
    expect(flow.coverageRounds).toEqual({ value: null, n: 0 });
    expect(flow.mergesPerWeek).toEqual({ value: 0, n: 0 });
  });
});
