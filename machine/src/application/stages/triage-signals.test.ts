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

describe("withTriageSignals's source labels", () => {
  it("hands the labels the card was taken in with to the classifier, so a security label still knocks the priority out", async () => {
    const seen: Array<{ labels?: string[] | undefined }> = [];
    const classify = async (issue: { labels?: string[] | undefined }) => (seen.push(issue), classification);
    const github = task({ source: { kind: "github", repo: "o/n", number: 7, url: "https://github.com/o/n/issues/7", labels: ["security", "bug"] } });
    const jira = task({ source: { kind: "jira", key: "P-1", url: "https://j/P-1", issueType: "Bug", labels: ["security"] } });
    const runner = withTriageSignals(async () => ({ outcome: "needs_input" }), { classify: classify as never, save: async () => {} });
    await runner(context({ task: github }));
    await runner(context({ task: jira }));
    await runner(context({ task: task({ source: null }) }));
    expect(seen.map((i) => i.labels)).toEqual([["security", "bug"], ["security"], []]);
  });
});

describe("withTriageSignals and the question council", () => {
  const sub = { answer: 1, confidence: 0.9 };
  const reading = (signals: NonNullable<TaskRow["classification"]>["signals"]) => ({
    ...classification, kind: "bug", kindConfidence: 0.9, sizeBucket: "S" as const, priority: "P2" as const, riskPrelim: "low" as const, confidence: 0.5,
    signals: { kind: { answer: "bug", confidence: 0.9 }, size: { answer: "S", confidence: 0.8 }, who: sub, what: sub, impact: sub, time: sub, demand: sub, risk_prelim: { answer: "low", confidence: 0.9 }, archive: { answer: false, confidence: 0.95 }, ...signals },
  });
  const kindOpen = reading({ kind: { answer: "bug", confidence: 0.5 } });
  const kindAndRiskOpen = reading({ kind: { answer: "bug", confidence: 0.5 }, risk_prelim: { answer: "low", confidence: 0.4 } });
  const settled = reading({});
  const KIND = "Is this a bug or a feature? The model read it as a bug, 0.50";
  const RISK = "How risky is the change: low, medium or high? The model read it as low, 0.40";
  type Asked = Parameters<NonNullable<Parameters<typeof withTriageSignals>[1]["council"]>>[1];
  /** A council that answers the questions whose text it has an answer for; every other question gets `null`. */
  const councilOf = (answers: Record<string, { answer: string | null; confidence: number; evidence?: string[] }>, seen: Asked[] = []) => async (_context: StageContext, asked: Asked): Promise<StageResult> => {
    seen.push(asked);
    return { outcome: "pass", detail: { answers: asked.questions.map((q) => ({ id: q.id, answer: null, confidence: 0, evidence: [], ...answers[q.question] })) } };
  };
  /** The signals read the answers so far: with any, the reading is settled; without, it is `open`. */
  const classifyBy = (open: typeof kindOpen) => async (issue: { answers?: unknown[] | undefined }) => (issue.answers?.length ? settled : open);

  it("settles every question from the code: the person is not asked, and the signals and the agent run again with the answers", async () => {
    const issues: Array<{ answers?: unknown[] | undefined }> = [];
    const decisions: unknown[] = [];
    const saved: Array<{ record?: unknown }> = [];
    const inner: StageRunner = async (c) => {
      decisions.push(c.approvals.filter((a) => a.decision === "answered").map((a) => a.response));
      return agentPass();
    };
    const classify = async (issue: { answers?: unknown[] | undefined }) => (issues.push(issue), classifyBy(kindOpen)(issue));
    const council = councilOf({ [KIND]: { answer: "bug", confidence: 0.92, evidence: ["src/app.ts:12"] } });
    const result = await withTriageSignals(inner, { classify: classify as never, council, save: async (_id, patch) => void saved.push(patch as never) })(context());
    expect(result.outcome).toBe("pass");
    expect(issues.map((i) => i.answers ?? [])).toEqual([[], [{ question: KIND, answer: "bug" }]]);
    expect(decisions).toEqual([[expect.objectContaining({ answers: { [KIND]: "bug" } })]]);
    const record = TriageRecord.parse(saved.find((p) => p.record)!.record);
    expect(record.qa).toEqual([{ question: KIND, answer: "bug", by: "council", field: "kind", evidence: ["src/app.ts:12"] }]);
  });

  it("asks only what is left, and tells the person what the council settled so they can overrule it", async () => {
    const seen: Asked[] = [];
    const council = councilOf({ [KIND]: { answer: "bug", confidence: 0.9, evidence: ["a.ts:1", "b.ts:2"] } }, seen);
    // After the answer the kind is sure, the risk is still open.
    const classify = async (issue: { answers?: unknown[] | undefined }) => (issue.answers?.length ? reading({ risk_prelim: { answer: "low", confidence: 0.4 } }) : kindAndRiskOpen);
    const result = await withTriageSignals(async () => agentPass(), { classify: classify as never, council, save: async () => {} })(context());
    expect(seen).toHaveLength(1);
    expect(result.outcome).toBe("needs_input");
    expect(result.needsInput).toEqual([{ question: RISK, recommended: "low" }]);
    expect(result.detail).toMatchObject({ askedBy: "triage", settledByCouncil: [{ question: KIND, answer: "bug", confidence: 0.9, evidence: ["a.ts:1", "b.ts:2"] }] });
  });

  it("runs the council once per entry, with every open question, the machine's carrying field, guess and confidence", async () => {
    const seen: Asked[] = [];
    const result = await withTriageSignals(async () => agentPass(), { classify: async () => kindAndRiskOpen, council: councilOf({}, seen), save: async () => {} })(context());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.questions).toEqual([
      { id: "q1", question: RISK, recommended: "low", field: "risk", guess: "low", confidence: 0.4 },
      { id: "q2", question: KIND, recommended: "bug", field: "kind", guess: "bug", confidence: 0.5 },
    ]);
    expect(seen[0]!.card).toEqual({ title: "Which Postgres?", description: "Is 14 fine?" });
    expect(result.needsInput).toHaveLength(2);
    expect(result.detail?.settledByCouncil).toBeUndefined();
  });

  it("sends the agent's own questions with nulls, and runs the agent again with what the council settled", async () => {
    const seen: Asked[] = [];
    let runs = 0;
    const inner: StageRunner = async (c) =>
      ++runs === 1 ? { outcome: "needs_input", needsInput: [{ question: "Which db?", recommended: null }], detail: { summary: "s" } } : (expect(c.approvals.some((a) => (a.response?.answers as Record<string, string> | undefined)?.["Which db?"] === "sqlite")).toBe(true), agentPass());
    const result = await withTriageSignals(inner, { classify: async () => settled, council: councilOf({ "Which db?": { answer: "sqlite", confidence: 0.85, evidence: ["db.ts:3"] } }, seen), save: async () => {} })(context());
    expect(seen[0]!.questions).toEqual([{ id: "q1", question: "Which db?", recommended: null, field: null, guess: null, confidence: null }]);
    expect(runs).toBe(2);
    expect(result.outcome).toBe("pass");
  });

  it("never sends an urgency or an archive question: they always reach the person", async () => {
    const seen: Asked[] = [];
    const open = reading({ kind: { answer: "bug", confidence: 0.5 }, who: { answer: 1, confidence: 0.3 }, archive: { answer: true, confidence: 0.5 } });
    const result = await withTriageSignals(async () => agentPass(), { classify: async () => open, council: councilOf({}, seen), save: async () => {} })(context());
    expect(seen[0]!.questions.map((q) => q.field)).toEqual(["kind"]);
    expect(result.needsInput?.map((q) => q.question)).toEqual(expect.arrayContaining([expect.stringContaining("urgent"), expect.stringContaining("archived")]));
    const onlyPerson = await withTriageSignals(async () => agentPass(), { classify: async () => reading({ who: { answer: 1, confidence: 0.3 } }), council: councilOf({}, seen), save: async () => {} })(context());
    expect(seen).toHaveLength(1);
    expect(onlyPerson.outcome).toBe("needs_input");
  });

  it("asks the person when the answer is under the bar: the field's own bar for a machine question, the council's for the agent's", async () => {
    const answer = { [KIND]: { answer: "bug", confidence: 0.7, evidence: ["a:1"] }, "Which db?": { answer: "sqlite", confidence: 0.7, evidence: ["a:1"] } };
    const under = await withTriageSignals(async () => agentPass(), { classify: async () => kindOpen, council: councilOf(answer), save: async () => {} })(context());
    expect(under.outcome).toBe("needs_input");
    // The repo sets the kind's own bar to 0.6: 0.7 settles it. The council's bar stays 0.8 for an agent question.
    const policy = async () => ({ factory: FACTORY_DEFAULTS, decisions: { triage_signals: { kind: { proceed: 0.6 } } } });
    const own = await withTriageSignals(async () => agentPass(), { classify: classifyBy(kindOpen) as never, policy, council: councilOf(answer), save: async () => {} })(context());
    expect(own.outcome).toBe("pass");
    const asks: StageRunner = async () => ({ outcome: "needs_input", needsInput: [{ question: "Which db?", recommended: null }], detail: { summary: "s" } });
    const agent = await withTriageSignals(asks, { classify: null, policy, council: councilOf(answer), save: async () => {} })(context());
    expect(agent.outcome).toBe("needs_input");
    const bar = async () => ({ factory: { ...FACTORY_DEFAULTS, triage: { ...FACTORY_DEFAULTS.triage, council: { enabled: true, bar: 0.6 } } } });
    const lowered = await withTriageSignals(async (c) => (c.approvals.length ? agentPass() : asks(c)), { classify: async () => settled, policy: bar, council: councilOf(answer), save: async () => {} })(context());
    expect(lowered.outcome).toBe("pass");
  });

  it("asks the person every question, with a note, when the council fails, times out or answers badly", async () => {
    const notes: string[] = [];
    const note = async (text: string) => void notes.push(text);
    const run = (council: NonNullable<Parameters<typeof withTriageSignals>[1]["council"]>) => withTriageSignals(async () => agentPass(), { classify: async () => kindAndRiskOpen, council, save: async () => {} })(context({ note }));
    for (const council of [async () => Promise.reject(new Error("engine down")), async () => ({ outcome: "fail" as const, detail: { error: "timeout" } }), async () => ({ outcome: "pass" as const, detail: { answers: "nope" } })]) {
      const result = await run(council);
      expect(result.outcome).toBe("needs_input");
      expect(result.needsInput).toHaveLength(2);
      expect(result.detail?.settledByCouncil).toBeUndefined();
    }
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("engine down");
  });

  it("does today's thing when the council is off in the repo's config or has no runner", async () => {
    const seen: Asked[] = [];
    const off = async () => ({ factory: { ...FACTORY_DEFAULTS, triage: { ...FACTORY_DEFAULTS.triage, council: { enabled: false, bar: 0.8 } } } });
    const result = await withTriageSignals(async () => agentPass(), { classify: async () => kindOpen, policy: off, council: councilOf({ [KIND]: { answer: "bug", confidence: 1, evidence: ["a:1"] } }, seen), save: async () => {} })(context());
    expect(seen).toEqual([]);
    expect(result.needsInput).toEqual([{ question: KIND, recommended: "bug" }]);
    expect((await withTriageSignals(async () => agentPass(), { classify: async () => kindOpen, save: async () => {} })(context())).outcome).toBe("needs_input");
  });

  it("keeps the council's answers on the next entry: they are read as the person's are, and the record marks who answered", async () => {
    const gate = { kind: "awaiting_answers", decision: "answered", response: { answers: { [RISK]: "medium" } }, requested: { askedBy: "triage", settledByCouncil: [{ question: KIND, answer: "bug", confidence: 0.9, evidence: ["a.ts:1"] }] } };
    const issues: Array<{ answers?: unknown[] | undefined }> = [];
    const saved: Array<{ record?: unknown }> = [];
    const result = await withTriageSignals(async () => agentPass(), { classify: (async (issue: { answers?: unknown[] }) => (issues.push(issue), settled)) as never, council: councilOf({}), save: async (_id, patch) => void saved.push(patch as never) })(context({ approvals: [gate] as never }));
    expect(result.outcome).toBe("pass");
    expect(issues[0]!.answers).toEqual([{ question: KIND, answer: "bug" }, { question: RISK, answer: "medium" }]);
    const record = TriageRecord.parse(saved.find((p) => p.record)!.record);
    expect(record.qa).toEqual([{ question: KIND, answer: "bug", by: "council", evidence: ["a.ts:1"] }, { question: RISK, answer: "medium" }]);
  });

  it("does not count the council's settling as a round of questions to the person", async () => {
    const full = Array.from({ length: 2 }, () => ({ kind: "awaiting_answers", decision: "answered", response: { answers: { q: "a" } }, requested: { askedBy: "triage" } })) as never;
    // Two rounds are spent: the council settles the one question that is open, so there is nothing to escalate.
    const result = await withTriageSignals(async () => agentPass(), { classify: classifyBy(kindOpen) as never, council: councilOf({ [KIND]: { answer: "bug", confidence: 0.9, evidence: ["a:1"] } }), save: async () => {} })(context({ approvals: full }));
    expect(result.outcome).toBe("pass");
  });
});
