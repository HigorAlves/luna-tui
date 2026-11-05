import { FACTORY_DEFAULTS, TriageRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageRunner } from "../ports.ts";
import { withTriageSignals } from "./triage-signals.ts";

const task = (over: Partial<TaskRow> = {}): TaskRow => ({ id: "t1", title: "Which Postgres?", description: "Is 14 fine?", criteria: [], repoPath: "/repo", source: { kind: "github", repo: "o/n", number: 7, url: "https://github.com/o/n/issues/7" }, classification: null, ...over }) as unknown as TaskRow;
const context = (over: Partial<StageContext> = {}): StageContext => ({ task: task(), stage: "triage", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal, ...over });
const classification = { kind: "bug", area: "board", ready: true, size: 1, urgency: 2, risk: 1, archive: false, archiveReason: "none", confidence: 0.8, at: "2026-11-04T00:00:00.000Z", model: "m", signals: {} };

describe("withTriageSignals's record", () => {
  const draft = { kind: "bug", goal: "Stop the board panicking on resize", size: "small", urgency: "high", risk: "low", reason: "one function, tests exist" };
  const signals = { kind: { answer: "bug", confidence: 0.9 }, size: { answer: 1, confidence: 0.8 } };

  it("assembles the TriageRecord from the draft, the signals and the answered questions, and saves it", async () => {
    const saved: unknown[] = [];
    const inner: StageRunner = async () => ({ outcome: "pass", detail: { outcome: "fast_lane", record: draft }, run: { info: { modelId: "claude-opus" } as never } });
    const approvals = [
      { kind: "triage", decision: "answered", response: { answers: { "Which OS?": "macOS" } }, requested: {} },
      { kind: "awaiting_approval", decision: "approved", response: null, requested: {} },
    ] as never;
    const runner = withTriageSignals(inner, { classify: null, save: async (id, patch) => void saved.push([id, patch]) });
    const result = await runner(context({ task: task({ classification: { ...classification, signals } }), approvals }));
    expect(result.outcome).toBe("pass");
    const [[id, patch]] = saved as [[string, { record: unknown }]];
    expect(id).toBe("t1");
    const record = TriageRecord.parse(patch.record);
    expect(record).toMatchObject({ ...draft, source: "github", decision: "fast_lane", signals, qa: [{ question: "Which OS?", answer: "macOS" }], model: "claude-opus" });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it("saves no record when triage did not pass or sent no draft; a manual ticket's source is manual", async () => {
    const saved: unknown[] = [];
    const save = async (id: string, patch: unknown) => void saved.push([id, patch]);
    await withTriageSignals(async () => ({ outcome: "needs_input", detail: { record: draft } }), { classify: null, save })(context());
    await withTriageSignals(async () => ({ outcome: "pass", detail: { outcome: "plan" } }), { classify: null, save })(context());
    expect(saved).toEqual([]);
    await withTriageSignals(async () => ({ outcome: "pass", detail: { outcome: "plan", record: draft } }), { classify: null, save })(context({ task: task({ source: null }) }));
    expect((saved[0] as [string, { record: { source: string; model: string } }])[1].record).toMatchObject({ source: "manual", decision: "plan", model: "unknown", signals: {} });
  });
});

describe("withTriageSignals", () => {
  it("classifies a ticket that arrived without signals, saves them and hands them to triage", async () => {
    const saved: unknown[] = [];
    let seen: TaskRow | undefined;
    const inner: StageRunner = async (c) => {
      seen = c.task;
      return { outcome: "pass" };
    };
    const asked: unknown[] = [];
    const runner = withTriageSignals(inner, {
      classify: async (issue, repoPath) => {
        asked.push([issue, repoPath]);
        return classification;
      },
      save: async (id, patch) => {
        saved.push([id, patch]);
      },
    });
    await runner(context());
    expect(asked).toEqual([[{ title: "Which Postgres?", description: "Is 14 fine?", labels: [], source: "https://github.com/o/n/issues/7" }, "/repo"]]);
    expect(saved).toEqual([["t1", { classification }]]);
    expect(seen?.classification).toEqual(classification);
  });

  it("runs the signals on every entry, even for a card that has some, and the new reading replaces the old", async () => {
    const saved: unknown[] = [];
    const seen: Array<TaskRow["classification"]> = [];
    const inner: StageRunner = async (c) => {
      seen.push(c.task.classification);
      return { outcome: "pass" };
    };
    const fresh = { ...classification, kind: "feature", confidence: 0.95 };
    let calls = 0;
    const runner = withTriageSignals(inner, { classify: async () => (calls++, fresh), save: async (id, patch) => void saved.push([id, patch]) });
    await runner(context({ task: task({ classification }) }));
    expect(calls).toBe(1);
    expect(seen).toEqual([fresh]);
    expect(saved).toEqual([["t1", { classification: fresh }]]);
  });

  it("puts the answers so far in the issue the signals read, oldest first, and the repo's scoring in the options", async () => {
    const approvals = [
      { kind: "awaiting_answers", decision: "answered", response: { answers: { "Which OS?": "macOS", "Which version?": "14.2" } }, requested: {} },
      { kind: "awaiting_approval", decision: "approved", response: null, requested: {} },
    ] as never;
    const asked: Array<[unknown, unknown]> = [];
    const factory = { ...FACTORY_DEFAULTS, scoring: { weights: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, bands: { P0: 14, P1: 10, P2: 6 } } };
    const runner = withTriageSignals(async () => ({ outcome: "pass" }), {
      classify: async (issue, _repo, options) => (asked.push([issue, options]), classification),
      policy: async () => ({ factory }),
      save: async () => {},
    });
    await runner(context({ approvals }));
    expect(asked).toEqual([[expect.objectContaining({ answers: [{ question: "Which OS?", answer: "macOS" }, { question: "Which version?", answer: "14.2" }] }), { weights: factory.scoring.weights, bands: factory.scoring.bands }]]);
  });

  it("keeps the previous classification, says so and goes on when the signals fail or answer nothing", async () => {
    const seen: Array<TaskRow["classification"]> = [];
    const inner: StageRunner = async (c) => {
      seen.push(c.task.classification);
      return { outcome: "pass" };
    };
    const saved: unknown[] = [];
    const save = async (id: string, patch: unknown) => void saved.push([id, patch]);
    const notes: string[] = [];
    const note = async (text: string) => void notes.push(text);
    const lines: string[] = [];
    const old = task({ classification });
    await withTriageSignals(inner, { classify: async () => Promise.reject(new Error("boom")), save, log: (l) => lines.push(l) })(context({ task: old, note }));
    await withTriageSignals(inner, { classify: async () => null, save })(context({ task: old, note }));
    await withTriageSignals(inner, { classify: null, save })(context());
    expect(seen).toEqual([classification, classification, null]);
    expect(saved).toEqual([]);
    expect(lines).toEqual([expect.stringContaining("boom")]);
    expect(notes).toEqual([expect.stringContaining("boom"), expect.stringContaining("kept")]);
  });
});
