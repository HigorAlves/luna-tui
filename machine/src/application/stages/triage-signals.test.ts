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

describe("withTriageSignals and the confidence policy", () => {
  const sub = { answer: 1, confidence: 0.9 };
  const read = (signals: NonNullable<TaskRow["classification"]>["signals"]) => ({
    ...classification, kind: "bug", kindConfidence: 0.9, sizeBucket: "S" as const, priority: "P2" as const, riskPrelim: "low" as const, confidence: 0.5,
    signals: { kind: { answer: "bug", confidence: 0.9 }, size: { answer: "S", confidence: 0.8 }, who: sub, what: sub, impact: sub, time: sub, demand: sub, risk_prelim: { answer: "low", confidence: 0.9 }, archive: { answer: false, confidence: 0.95 }, ...signals },
  });

  it("stops at the person's questions, one per field under its flag bar, the least sure first, with the guess and its confidence, and does not run the agent", async () => {
    let ran = 0;
    const runner = withTriageSignals(async () => (ran++, { outcome: "pass" }), { classify: async () => read({ kind: { answer: "bug", confidence: 0.62 }, risk_prelim: { answer: "low", confidence: 0.4 } }), save: async () => {} });
    const result = await runner(context());
    expect(ran).toBe(0);
    expect(result.outcome).toBe("needs_input");
    expect(result.needsInput).toEqual([
      { question: "How risky is the change: low, medium or high? The model read it as low, 0.40", recommended: "low" },
      { question: "Is this a bug or a feature? The model read it as a bug, 0.62", recommended: "bug" },
    ]);
    expect(result.detail).toMatchObject({ asked: [{ field: "risk", guess: "low", confidence: 0.4 }, { field: "kind", guess: "bug", confidence: 0.62 }] });
  });

  it("goes on to the agent for a field in the flag band, which the plan gate will show", async () => {
    let ran = 0;
    const runner = withTriageSignals(async () => (ran++, { outcome: "pass" }), { classify: async () => read({ size: { answer: "S", confidence: 0.5 } }), save: async () => {} });
    expect((await runner(context())).outcome).toBe("pass");
    expect(ran).toBe(1);
  });

  it("takes the repo's bars: its luna.yaml confidence config and its policy.decisions per question", async () => {
    const low = read({ kind: { answer: "bug", confidence: 0.5 } });
    const factory = { ...FACTORY_DEFAULTS, triage: { ...FACTORY_DEFAULTS.triage, confidence: { ...FACTORY_DEFAULTS.triage.confidence, kind: 0.5 } } };
    const withBars = (policy: { factory: typeof factory; decisions?: Record<string, Record<string, { proceed?: number; flag?: number }>> }) =>
      withTriageSignals(async () => ({ outcome: "pass" }), { classify: async () => low, policy: async () => policy, save: async () => {} });
    expect((await withBars({ factory })(context())).outcome).toBe("pass");
    expect((await withBars({ factory: FACTORY_DEFAULTS })(context())).outcome).toBe("needs_input");
    expect((await withBars({ factory: FACTORY_DEFAULTS, decisions: { triage_signals: { kind: { proceed: 0.4 } } } })(context())).outcome).toBe("pass");
  });

  it("does not ask on a reading it did not get this time", async () => {
    const runner = withTriageSignals(async () => ({ outcome: "pass" }), { classify: async () => null, save: async () => {} });
    expect((await runner(context({ task: task({ classification: read({ kind: { answer: "bug", confidence: 0.1 } }) }) }))).outcome).toBe("pass");
  });
});

describe("withTriageSignals and the bounds on asking", () => {
  const sub = { answer: 1, confidence: 0.9 };
  const lowAll = {
    ...classification, kind: "bug", kindConfidence: 0.3, sizeBucket: "S" as const, priority: "P2" as const, riskPrelim: "low" as const, confidence: 0.3,
    signals: { kind: { answer: "bug", confidence: 0.3 }, size: { answer: "S", confidence: 0.2 }, who: { answer: 1, confidence: 0.4 }, what: sub, impact: sub, time: sub, demand: sub, risk_prelim: { answer: "low", confidence: 0.5 }, archive: { answer: true, confidence: 0.6 } },
  };
  const round = (n: number) => Array.from({ length: n }, () => ({ kind: "awaiting_answers", decision: "answered", response: { answers: { q: "a" } }, requested: { askedBy: "triage" } })) as never;

  it("asks at most three questions a round, the least sure first, and marks them as triage's", async () => {
    const result = await withTriageSignals(async () => ({ outcome: "pass" }), { classify: async () => lowAll, save: async () => {} })(context());
    expect(result.outcome).toBe("needs_input");
    expect(result.needsInput).toHaveLength(3);
    expect((result.detail?.asked as Array<{ field: string }>).map((a) => a.field)).toEqual(["size", "kind", "urgency"]);
    expect(result.detail).toMatchObject({ askedBy: "triage" });
  });

  it("escalates to a person, listing the open questions, instead of a third round", async () => {
    const result = await withTriageSignals(async () => ({ outcome: "pass" }), { classify: async () => lowAll, save: async () => {} })(context({ approvals: round(2) }));
    expect(result.outcome).toBe("escalated");
    expect(result.detail?.reason).toMatch(/after 2 rounds/);
    expect(result.detail?.reason).toContain("How big is the change");
    expect(result.detail?.reason).toContain("Is this a bug or a feature?");
    expect(result.detail?.reason).toContain("How risky");
  });

  it("counts only triage's rounds, and takes the repo's caps", async () => {
    const other = [{ kind: "awaiting_answers", decision: "answered", response: null, requested: {} }] as never;
    const run = (approvals: never, max_rounds: number, max_questions = 3) =>
      withTriageSignals(async () => ({ outcome: "pass" }), {
        classify: async () => lowAll,
        policy: async () => ({ factory: { ...FACTORY_DEFAULTS, triage: { ...FACTORY_DEFAULTS.triage, max_rounds, max_questions } } }),
        save: async () => {},
      })(context({ approvals }));
    expect((await run(other, 2)).outcome).toBe("needs_input");
    expect((await run(round(1), 1)).outcome).toBe("escalated");
    expect((await run(round(2), 3)).outcome).toBe("needs_input");
    expect((await run([] as never, 2, 1)).needsInput).toHaveLength(1);
  });

  it("holds the agent's own questions to the same bounds", async () => {
    const asks = async () => ({ outcome: "needs_input" as const, needsInput: [1, 2, 3, 4].map((n) => ({ question: `q${n}`, recommended: null })), detail: { summary: "s" } });
    const first = await withTriageSignals(asks, { classify: null, save: async () => {} })(context());
    expect(first.needsInput).toHaveLength(3);
    expect(first.detail).toMatchObject({ askedBy: "triage" });
    const third = await withTriageSignals(asks, { classify: null, save: async () => {} })(context({ approvals: round(2) }));
    expect(third).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("q1") } });
  });
});
