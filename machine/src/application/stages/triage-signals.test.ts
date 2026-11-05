import { FACTORY_DEFAULTS, TriageRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { withTriageSignals } from "./triage-signals.ts";

const task = (over: Partial<TaskRow> = {}): TaskRow => ({ id: "t1", title: "Which Postgres?", description: "Is 14 fine?", criteria: [], repoPath: "/repo", source: { kind: "github", repo: "o/n", number: 7, url: "https://github.com/o/n/issues/7" }, classification: null, ...over }) as unknown as TaskRow;
const context = (over: Partial<StageContext> = {}): StageContext => ({ task: task(), stage: "triage", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal, ...over });
const classification = {
  kind: "bug", ready: true, size: 1, sizeBucket: "S", typeOfWork: "backend", priority: "P2", riskPrelim: "low", subScores: { who: 2, what: 2, impact: 2, time: 1, demand: 1 },
  archive: false, archiveReason: "none", confidence: 0.8, at: "2026-11-04T00:00:00.000Z", model: "m", signals: {},
} as NonNullable<TaskRow["classification"]>;
const draft = { goal: "Stop the board panicking on resize", reason: "one function, tests exist" };
/** What triage's agent hands back when it wrote its part: a summary, the goal sentence and the reason. */
const agentPass = (over: Record<string, unknown> = {}): StageResult => ({ outcome: "pass", detail: { summary: "The board panics on resize.", outcome: "plan", record: draft, ...over } });

describe("withTriageSignals's record", () => {
  const signals = { kind: { answer: "bug", confidence: 0.9 }, size: { answer: "S", confidence: 0.8 } };
  const answered = [
    { kind: "triage", decision: "answered", response: { answers: { "Which OS?": "macOS" } }, requested: {} },
    { kind: "awaiting_approval", decision: "approved", response: null, requested: {} },
  ] as never;

  it("composes the record: the agent's words around the machine's facts, decided by the machine, at version 1", async () => {
    const saved: unknown[] = [];
    const inner: StageRunner = async () => ({ ...agentPass(), run: { info: { modelId: "claude-opus" } as never } });
    const runner = withTriageSignals(inner, { classify: null, save: async (id, patch) => void saved.push([id, patch]) });
    const result = await runner(context({ task: task({ classification: { ...classification, signals } }), approvals: answered }));
    expect(result.outcome).toBe("pass");
    const [[id, patch]] = saved as [[string, { record: unknown }]];
    expect(id).toBe("t1");
    const record = TriageRecord.parse(patch.record);
    expect(record).toMatchObject({
      goal: draft.goal, reason: draft.reason, summary: "The board panics on resize.", source: "github", decision: "plan", signals, qa: [{ question: "Which OS?", answer: "macOS" }], model: "claude-opus",
      kind: "bug", typeOfWork: "backend", size: "S", urgencyDetail: { priority: "P2", subScores: { who: 2, what: 2, impact: 2, time: 1, demand: 1 } }, riskPrelim: "low", goalRef: "none", hintsUsed: [], decisionBy: "machine", version: 1,
    });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it("raises the version on a re-triage and puts only the previous version's number on the finished run", async () => {
    const previous = TriageRecord.parse({ ...composeFixture(), version: 2 });
    const result = await withTriageSignals(async () => agentPass(), { classify: null, save: async (_id, patch) => void expect((patch.record as { version: number }).version).toBe(3) })(context({ task: task({ classification, record: previous }) }));
    expect(result.detail).toMatchObject({ previousVersion: 2 });
    expect(JSON.stringify(result.detail)).not.toContain(previous.goal);
  });

  it("finds an epic or OKR id in the text for the goal reference", async () => {
    const saved: Array<{ record: { goalRef: string } }> = [];
    await withTriageSignals(async () => agentPass(), { classify: null, save: async (_id, patch) => void saved.push(patch as never) })(context({ task: task({ classification, description: "Part of EPIC-42" }) }));
    expect(saved[0]!.record.goalRef).toBe("EPIC-42");
  });

  it("saves no record when triage did not pass; a manual ticket's source is manual", async () => {
    const saved: unknown[] = [];
    const save = async (id: string, patch: unknown) => void saved.push([id, patch]);
    await withTriageSignals(async () => ({ outcome: "needs_input", detail: { record: draft } }), { classify: null, save })(context({ task: task({ classification }) }));
    expect(saved).toEqual([]);
    await withTriageSignals(async () => agentPass(), { classify: null, save })(context({ task: task({ source: null, classification }) }));
    expect((saved[0] as [string, { record: { source: string; model: string } }])[1].record).toMatchObject({ source: "manual", decision: "plan", model: "unknown" });
  });

  it("sends the agent round once with what is missing, then escalates: a card never leaves triage with an incomplete record", async () => {
    const seen: string[] = [];
    let runs = 0;
    const inner: StageRunner = async (c) => {
      runs++;
      seen.push(c.approvals.map((a) => a.reason ?? "").join("|"));
      return agentPass({ record: { goal: "", reason: "r" } });
    };
    const saved: unknown[] = [];
    const result = await withTriageSignals(inner, { classify: null, save: async (...a) => void saved.push(a) })(context({ task: task({ classification }) }));
    expect(runs).toBe(2);
    expect(seen[1]).toContain("goal");
    expect(result).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("goal") } });
    expect(saved).toEqual([]);
  });

  it("accepts the second try, and escalates a pass with no draft at all or no classification to compose from", async () => {
    let n = 0;
    const second = await withTriageSignals(async () => agentPass(n++ === 0 ? { record: undefined } : {}), { classify: null, save: async () => {} })(context({ task: task({ classification }) }));
    expect(second.outcome).toBe("pass");
    expect((await withTriageSignals(async () => agentPass({ record: undefined }), { classify: null, save: async () => {} })(context({ task: task({ classification }) }))).outcome).toBe("escalated");
    expect((await withTriageSignals(async () => agentPass(), { classify: null, save: async () => {} })(context())).outcome).toBe("escalated");
  });
});

function composeFixture() {
  return { source: "github", kind: "bug", goal: "An older goal", size: "S", urgency: "P2", risk: "low", signals: {}, qa: [], decision: "plan", reason: "r", at: "2026-11-04T00:00:00.000Z", model: "m" };
}

describe("withTriageSignals", () => {
  it("classifies a ticket that arrived without signals, saves them and hands them to triage", async () => {
    const saved: unknown[] = [];
    let seen: TaskRow | undefined;
    const inner: StageRunner = async (c) => {
      seen = c.task;
      return agentPass();
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
    expect(saved.filter((p) => "classification" in (p as [string, object])[1])).toEqual([["t1", { classification }]]);
    expect(seen?.classification).toEqual(classification);
  });

  it("runs the signals on every entry, even for a card that has some, and the new reading replaces the old", async () => {
    const saved: unknown[] = [];
    const seen: Array<TaskRow["classification"]> = [];
    const inner: StageRunner = async (c) => {
      seen.push(c.task.classification);
      return agentPass();
    };
    const fresh = { ...classification, kind: "feature", confidence: 0.95 };
    let calls = 0;
    const runner = withTriageSignals(inner, { classify: async () => (calls++, fresh), save: async (id, patch) => void saved.push([id, patch]) });
    await runner(context({ task: task({ classification }) }));
    expect(calls).toBe(1);
    expect(seen).toEqual([fresh]);
    expect(saved.filter((p) => "classification" in (p as [string, object])[1])).toEqual([["t1", { classification: fresh }]]);
  });

  it("puts the answers so far in the issue the signals read, oldest first, and the repo's scoring in the options", async () => {
    const approvals = [
      { kind: "awaiting_answers", decision: "answered", response: { answers: { "Which OS?": "macOS", "Which version?": "14.2" } }, requested: {} },
      { kind: "awaiting_approval", decision: "approved", response: null, requested: {} },
    ] as never;
    const asked: Array<[unknown, unknown]> = [];
    const factory = { ...FACTORY_DEFAULTS, scoring: { weights: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, bands: { P0: 14, P1: 10, P2: 6 } } };
    const runner = withTriageSignals(async () => agentPass(), {
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
      return agentPass();
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
    // The last card has no reading to compose a record from, so the agent is sent round once more before triage gives up on it.
    expect(seen).toEqual([classification, classification, null, null]);
    expect(saved.filter((p) => "classification" in (p as [string, object])[1])).toEqual([]);
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
    const runner = withTriageSignals(async () => (ran++, agentPass()), { classify: async () => read({ kind: { answer: "bug", confidence: 0.62 }, risk_prelim: { answer: "low", confidence: 0.4 } }), save: async () => {} });
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
    const runner = withTriageSignals(async () => (ran++, agentPass()), { classify: async () => read({ size: { answer: "S", confidence: 0.5 } }), save: async () => {} });
    expect((await runner(context())).outcome).toBe("pass");
    expect(ran).toBe(1);
  });

  it("takes the repo's bars: its luna.yaml confidence config and its policy.decisions per question", async () => {
    const low = read({ kind: { answer: "bug", confidence: 0.5 } });
    const factory = { ...FACTORY_DEFAULTS, triage: { ...FACTORY_DEFAULTS.triage, confidence: { ...FACTORY_DEFAULTS.triage.confidence, kind: 0.5 } } };
    const withBars = (policy: { factory: typeof factory; decisions?: Record<string, Record<string, { proceed?: number; flag?: number }>> }) =>
      withTriageSignals(async () => agentPass(), { classify: async () => low, policy: async () => policy, save: async () => {} });
    expect((await withBars({ factory })(context())).outcome).toBe("pass");
    expect((await withBars({ factory: FACTORY_DEFAULTS })(context())).outcome).toBe("needs_input");
    expect((await withBars({ factory: FACTORY_DEFAULTS, decisions: { triage_signals: { kind: { proceed: 0.4 } } } })(context())).outcome).toBe("pass");
  });

  it("does not ask on a reading it did not get this time", async () => {
    const runner = withTriageSignals(async () => agentPass(), { classify: async () => null, save: async () => {} });
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
    const result = await withTriageSignals(async () => agentPass(), { classify: async () => lowAll, save: async () => {} })(context());
    expect(result.outcome).toBe("needs_input");
    expect(result.needsInput).toHaveLength(3);
    expect((result.detail?.asked as Array<{ field: string }>).map((a) => a.field)).toEqual(["size", "kind", "urgency"]);
    expect(result.detail).toMatchObject({ askedBy: "triage" });
  });

  it("escalates to a person, listing the open questions, instead of a third round", async () => {
    const result = await withTriageSignals(async () => agentPass(), { classify: async () => lowAll, save: async () => {} })(context({ approvals: round(2) }));
    expect(result.outcome).toBe("escalated");
    expect(result.detail?.reason).toMatch(/after 2 rounds/);
    expect(result.detail?.reason).toContain("How big is the change");
    expect(result.detail?.reason).toContain("Is this a bug or a feature?");
    expect(result.detail?.reason).toContain("How risky");
  });

  it("counts only triage's rounds, and takes the repo's caps", async () => {
    const other = [{ kind: "awaiting_answers", decision: "answered", response: null, requested: {} }] as never;
    const run = (approvals: never, max_rounds: number, max_questions = 3) =>
      withTriageSignals(async () => agentPass(), {
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

describe("withTriageSignals and the fast lane", () => {
  const sure = { kind: { answer: "bug", confidence: 0.95 }, size: { answer: "S", confidence: 0.9 }, risk_prelim: { answer: "low", confidence: 0.95 } };
  const reading = (over: Record<string, unknown> = {}, signals: Record<string, unknown> = {}) => ({ ...classification, signals: { ...sure, ...signals }, ...over }) as NonNullable<TaskRow["classification"]>;
  const lane = async (c: NonNullable<TaskRow["classification"]>, agent: StageResult = agentPass(), graph?: Parameters<typeof withTriageSignals>[1]["graph"]) => {
    const saved: Array<{ record?: { decision: string } }> = [];
    const result = await withTriageSignals(async () => agent, { classify: null, ...(graph ? { graph } : {}), save: async (_id, patch) => void saved.push(patch as never) })(context({ task: task({ classification: c }) }));
    return { result, decision: saved.find((p) => p.record)?.record?.decision };
  };

  it("takes the fast lane by the rule: low risk, small, not infra or data, with no owner clash", async () => {
    const { result, decision } = await lane(reading());
    expect(decision).toBe("fast_lane");
    expect(result.detail).toMatchObject({ outcome: "fast_lane", laneNote: "owners not checked: no code graph" });
  });

  it("does not take it because the agent says so, when the card is medium risk", async () => {
    const { result, decision } = await lane(reading({ riskPrelim: "medium" }), agentPass({ outcome: "fast_lane" }));
    expect(decision).toBe("plan");
    expect(result.detail).toMatchObject({ outcome: "plan", laneNote: expect.stringContaining("preliminary risk is medium") });
  });

  it("plans a card that is infra, or too big, or whose size signal is only flagged", async () => {
    expect((await lane(reading({ typeOfWork: "infra" }))).decision).toBe("plan");
    expect((await lane(reading({ sizeBucket: "M" }))).decision).toBe("plan");
    expect((await lane(reading(), agentPass(), undefined)).decision).toBe("fast_lane");
    expect((await lane(reading({}, { size: { answer: "S", confidence: 0.5 } }))).decision).toBe("plan");
  });

  it("reads the owners from the code graph: one team is fine, two are not", async () => {
    const found = (owners: Array<{ path: string; owners: string[] }>, over: Record<string, unknown> = {}) => ({ locate: async () => ({ files: owners.map((o) => o.path), owners, stale: false, behind: 0, codeowners: true, ...over }) });
    const one = await lane(reading(), agentPass(), found([{ path: "a", owners: ["@acme/cart"] }]));
    expect(one.decision).toBe("fast_lane");
    expect(one.result.detail).not.toHaveProperty("laneNote");
    const clash = await lane(reading(), agentPass(), found([{ path: "a", owners: ["@acme/cart"] }, { path: "b", owners: ["@acme/auth"] }]));
    expect(clash.decision).toBe("plan");
    expect(clash.result.detail).toMatchObject({ laneNote: expect.stringContaining("2 owning teams") });
  });

  it("keeps the lane but records why the owners were not checked: no graph, a failed call, a stale graph, no match, no CODEOWNERS", async () => {
    const asks = async (graph: Parameters<typeof lane>[2]) => {
      const saved: Array<{ record?: { ownersNotChecked?: string } }> = [];
      const result = await withTriageSignals(async () => agentPass(), { classify: null, ...(graph ? { graph } : {}), save: async (_id, patch) => void saved.push(patch as never) })(context({ task: task({ classification: reading() }) }));
      return { reason: saved.find((p) => p.record)?.record?.ownersNotChecked, detail: result.detail };
    };
    const located = (over: Record<string, unknown>) => ({ locate: async () => ({ files: ["a"], owners: [{ path: "a", owners: ["@x/y"] }], stale: false, behind: 0, codeowners: true, ...over }) });
    expect((await asks(undefined)).reason).toBe("no code graph");
    expect((await asks({ locate: async () => null })).reason).toBe("no code graph");
    expect((await asks({ locate: async () => Promise.reject(new Error("graph file corrupt")) })).reason).toBe("the code graph could not be asked");
    expect((await asks(located({ stale: true, behind: 80 }))).reason).toBe("the code graph is stale (80 commits behind)");
    expect((await asks(located({ files: [], owners: [] }))).reason).toBe("no file matched the card's words");
    expect((await asks(located({ codeowners: false, owners: [] }))).reason).toBe("the repository has no CODEOWNERS");
    expect((await asks(located({}))).reason).toBeUndefined();
    expect((await asks(undefined)).detail).toMatchObject({ outcome: "fast_lane", laneNote: "owners not checked: no code graph" });
  });

  it("leaves a reply or an archive as the agent decided it", async () => {
    expect((await lane(reading(), agentPass({ outcome: "conversation" }))).decision).toBe("conversation");
    expect((await lane(reading(), agentPass({ outcome: "archive" }))).decision).toBe("archive");
  });
});
