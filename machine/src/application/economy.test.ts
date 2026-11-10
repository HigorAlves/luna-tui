import { type EconomyConfig, EconomyStatus, type GuardEventRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type LedgerRecord } from "../domain/economy/ledger.ts";
import { type PackTools } from "../domain/economy/prune.ts";
import { type FactRecord, type FactsFile } from "../domain/economy/lifecycle.ts";
import { type Digest, type ObservedCall, keepDigests } from "../domain/economy/observe-run.ts";
import { type EconomyStore, type Propose, type ProposerState, economy, noEconomy } from "./economy.ts";

const config: EconomyConfig = {
  loop_guard: "on",
  facts: "free",
  tool_prune: "propose",
  propose_every: 5,
  promote_cards: 5,
  guard: { judge_confidence: 0.8, redirects: 1, backstop_mult: 1.5, envelope_min_samples: 5 },
  prune: { runs: 10, min_cards: 2, cards: 5 },
};

function fakeStore(events: Record<string, unknown[]> = {}) {
  const state = { imported: [] as string[], envelopes: {} as Record<string, number[]>, ledger: [] as LedgerRecord[], guard: [] as GuardEventRow[], facts: { facts: [], injected: {} } as FactsFile, digests: [] as Digest[], calls: {} as Record<string, ObservedCall[]>, proposer: { closed: 0, counted: [] } as ProposerState, tools: {} as Record<string, PackTools> };
  const store: EconomyStore = {
    imported: async () => state.imported,
    markImported: async (_r, ids) => void (state.imported = [...new Set([...state.imported, ...ids])]),
    envelopes: async () => state.envelopes,
    updateEnvelopes: async (_r, change) => void (state.envelopes = change(state.envelopes)),
    appendLedger: async (_r, record) => void state.ledger.push(record),
    ledger: async () => state.ledger,
    appendGuard: async (_r, rows) => void state.guard.push(...rows),
    guard: async () => state.guard,
    facts: async () => state.facts,
    updateFacts: async (_r, change) => void (state.facts = change(state.facts)),
    appendDigest: async (_r, digest, calls = []) => {
      state.digests = keepDigests([...state.digests, digest]);
      state.calls = Object.fromEntries(Object.entries({ ...state.calls, [digest.runId]: calls }).filter(([id]) => state.digests.some((d) => d.runId === id)));
    },
    digests: async () => state.digests,
    calls: async () => state.calls,
    updateProposer: async (_r, change) => void (state.proposer = change(state.proposer)),
    tools: async () => state.tools,
    updateTools: async (_r, change) => void (state.tools = change(state.tools)),
    events: async (runId) => events[runId] ?? [],
  };
  return { state, store };
}

const calls = (n: number) => Array.from({ length: n }, () => ({ kind: "tool_call", payload: { tool: "Bash", target: "x", allowed: true } }));
const finished = (runId: string, over: Partial<Parameters<ReturnType<typeof economy>["afterRun"]>[0]> = {}) => ({ repoPath: "/r", runId, pack: "implementing" as const, cardId: "c1", outcome: "pass", tokens: null, config, ...over });

describe("economy.afterRun", () => {
  it("gives an envelope of p90 x 1.25 after five passing runs, none after four", async () => {
    const { state, store } = fakeStore(Object.fromEntries([10, 20, 30, 40, 50].map((n, i) => [`r${i}`, calls(n)])));
    const eco = economy(store);
    for (let i = 0; i < 4; i++) await eco.afterRun(finished(`r${i}`));
    expect((await eco.inputFor("/r", "implementing", config))?.guard).toMatchObject({ mode: "record", envelope: null });
    await eco.afterRun(finished("r4"));
    const guard = (await eco.inputFor("/r", "implementing", config))?.guard;
    expect(guard?.mode).toBe("on");
    expect(guard?.envelope).toBeCloseTo(57.5, 6);
    expect(state.ledger).toHaveLength(5);
  });

  it("learns only from a pass that made calls", async () => {
    const { state, store } = fakeStore({ r1: calls(5), r2: [] });
    const eco = economy(store);
    await eco.afterRun(finished("r1", { outcome: "fail" }));
    await eco.afterRun(finished("r2"));
    await eco.afterRun(finished("r3"));
    expect(state.envelopes).toEqual({});
    expect(state.ledger).toHaveLength(3);
  });

  it("keeps the run's guard events and the cost in the status", async () => {
    const { store } = fakeStore({ r1: [...calls(2), { kind: "economy.guard", payload: { action: "stop", calls: 2, cause: "repeat" } }] });
    const eco = economy(store);
    await eco.afterRun(finished("r1", { outcome: "fail", tokens: { input: 100, output: 0, cached: 0 } }));
    await eco.recordOverhead({ repoPath: "/r", runId: "j1", pack: "loop_judge", cardId: "c1", tokens: { input: 100, output: 0, cached: 0 } });
    const status = await eco.status("/r");
    expect(status.guard).toMatchObject([{ action: "stop", calls: 2, cause: "repeat", runId: "r1", pack: "implementing" }]);
    expect(status.cost).toEqual({ exec: 100, overhead: 100, overheadShare: 0.5, overheadUnpriced: 0 });
  });

  it("never throws", async () => {
    const { store } = fakeStore();
    const broken = economy({ ...store, appendLedger: async () => Promise.reject(new Error("disk full")) }, () => {});
    await expect(broken.afterRun(finished("r1"))).resolves.toBeUndefined();
  });
});

describe("economy.inputFor", () => {
  it("asks the judge only for packs with shell access", async () => {
    const eco = economy(fakeStore().store);
    expect((await eco.inputFor("/r", "implementing", config))?.guard?.judge).toBe(true);
    expect((await eco.inputFor("/r", "ticket_reply", config))?.guard?.judge).toBe(false);
  });

  it("carries the config's settings", async () => {
    const guard = (await economy(fakeStore().store).inputFor("/r", "implementing", config))?.guard;
    expect(guard).toMatchObject({ judgeConfidence: 0.8, redirects: 1, backstopMult: 1.5 });
  });

  it("is undefined with the guard off and for a decision pack", async () => {
    const eco = economy(fakeStore().store);
    expect(await eco.inputFor("/r", "implementing", { ...config, loop_guard: "off" })).toBeUndefined();
    expect(await eco.inputFor("/r", "red_check", config)).toBeUndefined();
  });

  it("keeps an envelope for each pack on its own", async () => {
    const { store } = fakeStore();
    await store.updateEnvelopes("/r", () => ({ implementing: [1, 2, 3, 4, 5] }));
    const eco = economy(store);
    expect((await eco.inputFor("/r", "verifying", config))?.guard?.envelope).toBeNull();
    expect((await eco.inputFor("/r", "implementing", config))?.guard?.envelope).not.toBeNull();
  });
});

// Tool pruning: the `triage` pack has web, a subagent, one skill and `card_search`; the runs below use none of them unless they say so.
const pruning: EconomyConfig = { ...config, loop_guard: "off", prune: { runs: 3, min_cards: 2, cards: 5 } };
const TRIAGE = ["web", "agent", "skill:code-discovery", "luna:card_search"];
const runOn = (n: number, cardId: string, extra: unknown[] = []) => ({ [`t${n}`]: [...calls(1), ...extra] });
async function idleRuns(eco: ReturnType<typeof economy>, from: number, n: number, config = pruning) {
  for (let i = from; i < from + n; i++) await eco.afterRun(finished(`t${i}`, { pack: "triage", cardId: `c${i % 2}`, config }));
}

describe("economy: tool pruning", () => {
  const stage = () => fakeStore(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, calls(1)])));

  it("proposes the units a pack never used, with their evidence, and hands the next run nothing yet", async () => {
    const { store } = stage();
    const eco = economy(store);
    await idleRuns(eco, 0, 3);
    const tools = (await eco.status("/r")).tools?.triage;
    expect(tools?.mask).toEqual([]);
    expect(tools?.proposal.map((p) => p.unit).sort()).toEqual([...TRIAGE].sort());
    expect(tools?.proposal[0]).toMatchObject({ unusedRuns: 3, cards: 2 });
    expect((await eco.inputFor("/r", "triage", pruning))?.mask).toBeUndefined();
  });

  it("one use removes the unit from the proposal for good", async () => {
    const { store } = fakeStore({ ...runOn(0, "c0", [{ kind: "tool_call", payload: { tool: "WebFetch", target: "u", allowed: true } }]), ...runOn(1, "c1"), ...runOn(2, "c0"), ...runOn(3, "c1"), ...runOn(4, "c0") });
    const eco = economy(store);
    await idleRuns(eco, 0, 5);
    expect((await eco.status("/r")).tools?.triage?.proposal.map((p) => p.unit)).not.toContain("web");
  });

  it("approve sends the mask on the next input, even with the guard and facts off", async () => {
    const { store } = stage();
    const eco = economy(store);
    await idleRuns(eco, 0, 3);
    expect(await eco.approveMask("/r", "triage")).toBe(true);
    expect((await eco.inputFor("/r", "triage", pruning))?.mask).toEqual({ web: true, agent: true, skills: ["code-discovery"], luna: ["card_search"] });
    expect((await eco.status("/r")).tools?.triage).toMatchObject({ mask: expect.arrayContaining(TRIAGE), proposal: [] });
    expect(EconomyStatus.safeParse(await eco.status("/r")).success).toBe(true);
  });

  it("approve with no proposal is false, and so is a pack the economy does not prune", async () => {
    const eco = economy(stage().store);
    expect(await eco.approveMask("/r", "triage")).toBe(false);
    expect(await eco.approveMask("/r", "red_check")).toBe(false);
  });

  it("restore brings a unit back and it is never proposed again", async () => {
    const { store } = stage();
    const eco = economy(store);
    await idleRuns(eco, 0, 3);
    await eco.approveMask("/r", "triage");
    expect(await eco.restore("/r", "triage", "web")).toBe(true);
    expect((await eco.inputFor("/r", "triage", pruning))?.mask?.web).toBeUndefined();
    await idleRuns(eco, 3, 9);
    expect((await eco.status("/r")).tools?.triage?.proposal.map((p) => p.unit)).not.toContain("web");
    expect(await eco.restore("/r", "triage", "nothing")).toBe(false);
  });

  it("a masked unit gathers no evidence", async () => {
    const { state, store } = stage();
    const eco = economy(store);
    await idleRuns(eco, 0, 3);
    await eco.approveMask("/r", "triage");
    const before = state.tools.triage!.units.web;
    await idleRuns(eco, 3, 4);
    expect(state.tools.triage!.units.web).toEqual(before);
  });

  it("folds nothing with tool_prune off, or for a run with no events", async () => {
    const { state, store } = fakeStore({ t0: calls(1) });
    const eco = economy(store);
    await idleRuns(eco, 0, 1, { ...pruning, tool_prune: "off" });
    await eco.afterRun(finished("none", { pack: "triage", config: pruning }));
    expect(state.tools).toEqual({});
  });

  it("a refused call is not a use", async () => {
    const refused = [{ kind: "tool_call", payload: { tool: "WebFetch", target: "u", allowed: false } }];
    const { store } = fakeStore({ t0: [...calls(1), ...refused], t1: [...calls(1), ...refused], t2: [...calls(1), ...refused] });
    const eco = economy(store);
    await idleRuns(eco, 0, 3);
    expect((await eco.status("/r")).tools?.triage?.proposal.map((p) => p.unit)).toContain("web");
  });

  it("noEconomy approves and restores nothing", async () => {
    const eco = noEconomy();
    expect(await eco.approveMask("/r", "triage")).toBe(false);
    expect(await eco.restore("/r", "triage", "web")).toBe(false);
  });
});

describe("noEconomy", () => {
  it("gives no input and keeps nothing", async () => {
    const eco = noEconomy();
    expect(await eco.inputFor("/r", "implementing", config)).toBeUndefined();
    await eco.afterRun(finished("r1"));
    expect((await eco.status("/r")).guard).toEqual([]);
  });
});

// The facts a repository learns: the runs below are the ones upstream's own example gives, `pytest` missing and `python -m pytest` working.
const result = (observation: unknown, ok = true) => ({ kind: "tool_result", payload: { id: "1", tool: "Bash", ok, observation } });
const pytestRun = () => [result({ intent: "test", form: "pytest", errorClass: "command_missing" }, false), result({ intent: "test", form: "python -m pytest", testsRan: true })];
const PYTEST_FACT = "`pytest …` fails here with command not found; `python -m pytest …` works.";
const learnedFrom = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i + 1}`, pytestRun()]));
async function learn(eco: ReturnType<typeof economy>, n: number, over: Partial<Parameters<ReturnType<typeof economy>["afterRun"]>[0]> = {}) {
  for (let i = 1; i <= n; i++) await eco.afterRun(finished(`r${i}`, { cardId: `c${i}`, ...over }));
}

describe("economy: learning facts", () => {
  it("makes an active form-repair fact of three runs where pytest is missing and python -m pytest works", async () => {
    const { store } = fakeStore(learnedFrom(3));
    const eco = economy(store);
    await learn(eco, 2);
    expect((await eco.status("/r")).facts).toMatchObject([{ family: "form_repair", state: "candidate", confirmations: 2 }]);
    await eco.afterRun(finished("r3", { cardId: "c3" }));
    const facts = (await eco.status("/r")).facts;
    expect(facts).toHaveLength(1);
    expect(facts?.[0]).toMatchObject({ family: "form_repair", source: "free", state: "active", text: PYTEST_FACT, exercised: 3, fired: 3 });
  });

  it("tells the next run a fact only once it applied in four runs, and in no pack that is not an agent pack", async () => {
    const { store } = fakeStore(learnedFrom(4));
    const eco = economy(store);
    await learn(eco, 3);
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toBeUndefined();
    await eco.afterRun(finished("r4", { cardId: "c4" }));
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toEqual([PYTEST_FACT]);
    expect(await eco.inputFor("/r", "red_check", config)).toBeUndefined();
  });

  it("gives facts without the guard when only the guard is off, and the guard without facts when facts are off", async () => {
    const { store } = fakeStore(learnedFrom(4));
    const eco = economy(store);
    await learn(eco, 4);
    expect(await eco.inputFor("/r", "implementing", { ...config, loop_guard: "off" })).toEqual({ facts: [PYTEST_FACT] });
    const off = await eco.inputFor("/r", "implementing", { ...config, facts: "off" });
    expect(off?.facts).toBeUndefined();
    expect(off?.guard).toBeDefined();
  });

  it("treats facts: free as on in this slice", async () => {
    const run = async (facts: "on" | "free") => {
      const { store } = fakeStore(learnedFrom(4));
      const eco = economy(store);
      await learn(eco, 4, { config: { ...config, facts } });
      return [(await eco.status("/r")).facts, await eco.inputFor("/r", "implementing", { ...config, facts })];
    };
    expect(await run("free")).toEqual(await run("on"));
  });

  it("folds nothing, injects nothing and keeps no digest with facts: off", async () => {
    const { state, store } = fakeStore(learnedFrom(4));
    const eco = economy(store);
    await learn(eco, 4, { config: { ...config, facts: "off" } });
    expect(state.facts).toEqual({ facts: [], injected: {} });
    expect(state.digests).toEqual([]);
    state.facts = { injected: {}, facts: [{ id: "a", family: "form_repair", source: "free", key: "test:pytest", text: PYTEST_FACT, state: "active", confirmations: 5, contradictions: 0, score: 3, exercised: 9, fired: 9, cards: [], firstRun: "r0", lastRun: "r0", streak: 0 }] };
    expect((await eco.inputFor("/r", "implementing", { ...config, facts: "off" }))?.facts).toBeUndefined();
    expect(state.facts.injected).toEqual({});
  });

  it("counts a run as having used the fact it was told when the working form ran and the old one did not", async () => {
    const run4 = [result({ intent: "test", form: "python -m pytest", testsRan: true })];
    const { state, store } = fakeStore({ ...learnedFrom(4), r5: run4, r6: run4, r7: run4, r8: run4, r9: run4 });
    const eco = economy(store);
    await learn(eco, 4);
    // The input records what the pack was told; the runs after it that never hit the old form still count, because they were told it.
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toEqual([PYTEST_FACT]);
    expect(state.facts.injected).toEqual({ implementing: [state.facts.facts[0]?.id] });
    for (const id of ["r5", "r6", "r7", "r8", "r9"]) await eco.afterRun(finished(id));
    expect(state.facts.facts[0]).toMatchObject({ state: "active", exercised: 9, fired: 9 });
  });

  it("retires the fact when the old form runs the tests, and stops telling it", async () => {
    const worksNow = [result({ intent: "test", form: "pytest", testsRan: true })];
    const { store } = fakeStore({ ...learnedFrom(4), r5: worksNow, r6: worksNow });
    const eco = economy(store);
    await learn(eco, 4);
    await eco.afterRun(finished("r5"));
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toEqual([PYTEST_FACT]);
    await eco.afterRun(finished("r6"));
    expect((await eco.status("/r")).facts?.[0]?.state).toBe("retired");
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toBeUndefined();
  });

  it("folds a run with no observed call as nothing: no decay, no digest", async () => {
    const { state, store } = fakeStore({ ...learnedFrom(3), r4: [{ kind: "tool_call", payload: { tool: "Read", target: "x", allowed: true } }] });
    const eco = economy(store);
    await learn(eco, 3);
    const before = JSON.stringify(state.facts);
    await eco.afterRun(finished("r4"));
    expect(JSON.stringify(state.facts)).toBe(before);
    expect(state.digests).toHaveLength(3);
  });

  it("keeps the run's digest for the proposer: the last eight runs, a line per call", async () => {
    const { state, store } = fakeStore(learnedFrom(10));
    const eco = economy(store);
    await learn(eco, 10);
    expect(state.digests.map((d) => d.runId)).toEqual(["r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10"]);
    expect(state.digests[0]).toMatchObject({ pack: "implementing", cardId: "c3", outcome: "pass", calls: 2, lines: ["test | pytest | command_missing", "test | python -m pytest | ok"] });
  });

  it("never fails a run for the facts: a broken facts file still leaves the ledger", async () => {
    const { state, store } = fakeStore(learnedFrom(1));
    const logged: string[] = [];
    const eco = economy({ ...store, updateFacts: async () => Promise.reject(new Error("disk full")) }, (line) => logged.push(line));
    await expect(eco.afterRun(finished("r1"))).resolves.toBeUndefined();
    expect(state.ledger).toHaveLength(1);
    expect(logged.join("\n")).toContain("disk full");
  });

  it("gives no facts when the facts file cannot be read", async () => {
    const { store } = fakeStore();
    const eco = economy({ ...store, facts: async () => Promise.reject(new Error("unreadable")) });
    expect((await eco.inputFor("/r", "implementing", config))?.guard).toBeDefined();
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toBeUndefined();
  });
});

describe("economy.dropFact", () => {
  it("drops a fact by id: it is no longer told, and the key is never learned again", async () => {
    const { store } = fakeStore(learnedFrom(8));
    const eco = economy(store);
    await learn(eco, 4);
    const id = (await eco.status("/r")).facts?.[0]?.id as string;
    expect(await eco.dropFact("/r", id)).toBe(true);
    expect((await eco.status("/r")).facts?.[0]?.state).toBe("dropped");
    expect((await eco.inputFor("/r", "implementing", config))?.facts).toBeUndefined();
    for (const run of ["r5", "r6", "r7", "r8"]) await eco.afterRun(finished(run));
    const facts = (await eco.status("/r")).facts;
    expect(facts).toHaveLength(1);
    expect(facts?.[0]?.state).toBe("dropped");
  });

  it("is false for an id nobody holds, and for noEconomy", async () => {
    expect(await economy(fakeStore().store).dropFact("/r", "nope")).toBe(false);
    expect(await noEconomy().dropFact("/r", "nope")).toBe(false);
  });
});

describe("economy.status facts", () => {
  it("lists each fact's id, family, source, state, text, counts and runs", async () => {
    const { store } = fakeStore(learnedFrom(3));
    const eco = economy(store);
    await learn(eco, 3);
    const [fact] = (await eco.status("/r")).facts ?? [];
    expect(Object.keys(fact ?? {}).sort()).toEqual(["confirmations", "contradictions", "exercised", "family", "fired", "id", "source", "state", "text"]);
    expect(EconomyStatus.safeParse(await eco.status("/r")).success).toBe(true);
  });
});

// The proposer and promotion. A run of the module form, editing `file`; a run of another build; the detector that says the module form held.
const detector = { scope: { all: [{ intent: "test" as const }] }, confirm: { all: [{ predicate: "tests_passed" as const }, { commandIncludes: "python -m pytest" }] }, contradict: { all: [{ errorClass: "command_missing" as const }] } };
const editing = (file: string) => [result({ intent: "test", form: "python -m pytest -q", testsRan: true }), result({ intent: "vcs", form: "git status", edits: [file] })];
const MANUAL_FACT = "Run the tests with `python -m pytest -q` from the repository root.";
const answer = (over: Record<string, unknown> = {}) => ({ facts: [{ text: MANUAL_FACT, section: "Commands", detector, cites: ["r1", "r2"], ...over }] });
const onCfg: EconomyConfig = { ...config, facts: "on", propose_every: 3 };
const proposing = (reply: unknown): { propose: Propose; asked: Array<Parameters<Propose>[0]> } => {
  const asked: Array<Parameters<Propose>[0]> = [];
  return { asked, propose: async (input) => (asked.push(input), reply === null ? null : { answer: reply, runId: "p1", costUsd: 0.01 }) };
};
/** Folds `n` runs of the module form (run i edits `f<i>.ts`, on card c<i>) in a repository that proposes every third card. */
async function runs(eco: ReturnType<typeof economy>, from: number, to: number, config: EconomyConfig = onCfg) {
  for (let i = from; i <= to; i++) await eco.afterRun(finished(`r${i}`, { cardId: `c${i}`, config }));
}
const editedRuns = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i + 1}`, editing(`f${i + 1}.ts`)]));

describe("economy.cardClosed: the proposer's tick", () => {
  it("asks on the 3rd and the 6th closed card of a repository, not on the others", async () => {
    const { store } = fakeStore(editedRuns(6));
    const eco = economy(store);
    const { propose, asked } = proposing(answer());
    await runs(eco, 1, 6);
    const ticks: number[] = [];
    for (let n = 1; n <= 7; n++) {
      await eco.cardClosed("/r", `c${n}`, onCfg, propose);
      ticks.push(asked.length);
    }
    expect(ticks).toEqual([0, 0, 1, 1, 1, 2, 2]);
  });

  it("counts each repository's cards on their own, and a card once", async () => {
    const { store } = fakeStore(editedRuns(2));
    const eco = economy(store);
    await runs(eco, 1, 2);
    const { propose, asked } = proposing(answer());
    await eco.cardClosed("/r", "c1", onCfg, propose);
    await eco.cardClosed("/r", "c1", onCfg, propose);
    await eco.cardClosed("/other", "c1", onCfg, propose);
    await eco.cardClosed("/r", "c2", onCfg, propose);
    expect(asked).toHaveLength(0);
  });

  it("does not ask with facts: free or facts: off, though the cards are still counted for free", async () => {
    const { store } = fakeStore(editedRuns(2));
    const eco = economy(store);
    await runs(eco, 1, 2);
    const { propose, asked } = proposing(answer());
    for (const facts of ["free", "off"] as const) for (let n = 1; n <= 6; n++) await eco.cardClosed(`/${facts}`, `c${n}`, { ...onCfg, facts }, propose);
    expect(asked).toHaveLength(0);
  });

  it("does not ask while fewer than two runs are digested", async () => {
    const { store } = fakeStore(editedRuns(1));
    const eco = economy(store);
    await runs(eco, 1, 1);
    const { propose, asked } = proposing(answer());
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/r", `c${n}`, onCfg, propose);
    expect(asked).toHaveLength(0);
  });

  it("shows the proposer the repository's name, its digests and the texts of the facts it holds", async () => {
    const { state, store } = fakeStore({ ...learnedFrom(3), ...editedRuns(0) });
    const eco = economy(store);
    await learn(eco, 3);
    const { propose, asked } = proposing({ facts: [] });
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/work/my repo;x", `c${n}`, onCfg, propose);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ repo: "myrepox", known: [PYTEST_FACT] });
    expect(asked[0]!.digests.map((d) => d.runId)).toEqual(state.digests.map((d) => d.runId));
  });

  it("admits a proposed fact whose detector confirms on the runs it cites, and records the run as overhead", async () => {
    const { state, store } = fakeStore(editedRuns(3));
    const eco = economy(store);
    await runs(eco, 1, 3);
    const { propose } = proposing(answer());
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/r", `c${n}`, onCfg, propose);
    expect(state.facts.facts).toMatchObject([{ source: "proposed", family: "proposed", state: "active", text: MANUAL_FACT, confirmations: 3 }]);
    expect(state.ledger.at(-1)).toMatchObject({ kind: "overhead", pack: "fact_propose", card: "c3", costUsd: 0.01 });
    expect((await eco.status("/r")).facts).toMatchObject([{ source: "proposed", text: MANUAL_FACT }]);
  });

  it("changes nothing when the proposer fails, answers null or answers garbage, and still never throws", async () => {
    for (const reply of [null, "words", { facts: "no" }, { facts: [{ text: MANUAL_FACT }] }, answer({ cites: ["r1", "r99"] }), answer({ detector: { ...detector, scope: { all: [{ predicate: "ran_everything" }] } } })]) {
      const { state, store } = fakeStore(editedRuns(3));
      const eco = economy(store);
      await runs(eco, 1, 3);
      const { propose } = proposing(reply);
      for (let n = 1; n <= 3; n++) await expect(eco.cardClosed("/r", `c${n}`, onCfg, propose)).resolves.toBeUndefined();
      expect(state.facts.facts, JSON.stringify(reply)).toEqual([]);
    }
    const { state, store } = fakeStore(editedRuns(3));
    const eco = economy(store);
    await runs(eco, 1, 3);
    const boom: Propose = async () => Promise.reject(new Error("no credential"));
    for (let n = 1; n <= 3; n++) await expect(eco.cardClosed("/r", `c${n}`, onCfg, boom)).resolves.toBeUndefined();
    expect(state.facts.facts).toEqual([]);
    expect(state.ledger.filter((r) => r.kind === "overhead")).toEqual([]);
  });

  it("is nothing for noEconomy", async () => {
    const { propose, asked } = proposing(answer());
    for (let n = 1; n <= 3; n++) await noEconomy().cardClosed("/r", `c${n}`, onCfg, propose);
    expect(asked).toHaveLength(0);
  });
});

describe("economy: a proposed fact's life", () => {
  /** A repository where a proposed fact was admitted after three runs on cards c1..c3. */
  async function admitted(runCount: number) {
    const fake = fakeStore(editedRuns(runCount));
    const eco = economy(fake.store);
    await runs(eco, 1, 2);
    const { propose } = proposing(answer());
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/r", `c${n}`, onCfg, propose);
    return { ...fake, eco };
  }

  it("is a candidate that three runs on different files make active, and is told only after four runs in scope", async () => {
    const { state, eco } = await admitted(6);
    expect(state.facts.facts[0]).toMatchObject({ state: "candidate", confirmations: 2 });
    await runs(eco, 3, 3);
    expect(state.facts.facts[0]).toMatchObject({ state: "active", confirmations: 3, exercised: 3 });
    expect((await eco.inputFor("/r", "implementing", onCfg))?.manual).toBeUndefined();
    await runs(eco, 4, 4);
    expect((await eco.inputFor("/r", "implementing", onCfg))?.manual).toEqual([MANUAL_FACT]);
  });

  it("is told with facts: on only, never with free or off, and not to a decision pack", async () => {
    const { eco } = await admitted(6);
    await runs(eco, 3, 4);
    expect((await eco.inputFor("/r", "implementing", onCfg))?.manual).toEqual([MANUAL_FACT]);
    expect((await eco.inputFor("/r", "implementing", { ...onCfg, facts: "free" }))?.manual).toBeUndefined();
    expect((await eco.inputFor("/r", "implementing", { ...onCfg, facts: "off" }))?.manual).toBeUndefined();
    expect(await eco.inputFor("/r", "red_check", onCfg)).toBeUndefined();
  });

  it("stays a candidate when three confirming runs edited the same file", async () => {
    const same = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`r${i + 1}`, editing("same.ts")]));
    const { state, store } = fakeStore(same);
    const eco = economy(store);
    await runs(eco, 1, 2);
    const { propose } = proposing(answer());
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/r", `c${n}`, onCfg, propose);
    await runs(eco, 3, 6);
    expect(state.facts.facts[0]).toMatchObject({ state: "candidate", confirmations: 1, exercised: 6 });
  });

  it("is retired by a contradicting run and then no longer told", async () => {
    const missing = [result({ intent: "test", form: "pytest", errorClass: "command_missing" }, false)];
    const { state, store } = fakeStore({ ...editedRuns(4), r5: missing });
    const eco = economy(store);
    await runs(eco, 1, 2);
    const { propose } = proposing(answer());
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/r", `c${n}`, onCfg, propose);
    await runs(eco, 3, 4);
    expect((await eco.inputFor("/r", "implementing", onCfg))?.manual).toEqual([MANUAL_FACT]);
    await runs(eco, 5, 5);
    expect(state.facts.facts[0]).toMatchObject({ state: "retired", contradictions: 1 });
    expect((await eco.inputFor("/r", "implementing", onCfg))?.manual).toBeUndefined();
  });

  it("is dropped by a person and never told again", async () => {
    const { eco } = await admitted(6);
    await runs(eco, 3, 4);
    const id = (await eco.status("/r")).facts![0]!.id;
    expect(await eco.dropFact("/r", id)).toBe(true);
    expect((await eco.inputFor("/r", "implementing", onCfg))?.manual).toBeUndefined();
  });
});

describe("economy.promotable and economy.promoted", () => {
  const seed = (over: Partial<FactRecord>): FactRecord => ({ id: "f1", family: "proposed", source: "proposed", key: "k", text: MANUAL_FACT, state: "active", confirmations: 3, contradictions: 0, score: 2, exercised: 9, fired: 9, cards: ["c1", "c2", "c3", "c4", "c5"], firstRun: "r0", lastRun: "r0", streak: 0, detector, files: [], section: "Commands", ...over });
  const withFacts = (...facts: FactRecord[]) => {
    const fake = fakeStore();
    fake.state.facts = { facts, injected: {} };
    return { ...fake, eco: economy(fake.store) };
  };

  it("offers an active fact confirmed on five distinct cards with no contradiction, with its section", async () => {
    const { eco } = withFacts(seed({}));
    expect(await eco.promotable("/r", onCfg)).toEqual([{ id: "f1", text: MANUAL_FACT, section: "Commands" }]);
  });

  it("offers a free fact too, with no section of its own", async () => {
    const free = seed({ id: "f2", source: "free", family: "env_value", section: undefined, text: "Code needs `APP_ENV=test` here." });
    expect(await withFacts(free).eco.promotable("/r", onCfg)).toEqual([{ id: "f2", text: "Code needs `APP_ENV=test` here." }]);
  });

  it("offers nothing short of the bar: fewer cards, repeated cards, a contradiction, or a state other than active", async () => {
    const rest = [seed({ id: "a", cards: ["c1", "c2", "c3", "c4"] }), seed({ id: "b", cards: ["c1", "c1", "c1", "c1", "c1"] }), seed({ id: "c", contradictions: 1 }), ...(["candidate", "retired", "dropped", "promoted"] as const).map((state) => seed({ id: state, state }))];
    expect(await withFacts(...rest).eco.promotable("/r", onCfg)).toEqual([]);
    expect(await withFacts(seed({ id: "a", cards: ["c1", "c2", "c3"] })).eco.promotable("/r", { ...onCfg, promote_cards: 3 })).toHaveLength(1);
  });

  it("offers at most ten, and nothing with facts: off or for noEconomy", async () => {
    const many = Array.from({ length: 12 }, (_, i) => seed({ id: `f${i}`, text: `Fact ${i}.` }));
    const { eco } = withFacts(...many);
    expect(await eco.promotable("/r", onCfg)).toHaveLength(10);
    expect(await eco.promotable("/r", { ...onCfg, facts: "off" })).toEqual([]);
    expect(await noEconomy().promotable("/r", onCfg)).toEqual([]);
  });

  it("marks the facts promoted by id, so no later run is told them, and counts only the ones it held as active", async () => {
    const free = seed({ id: "f2", source: "free", family: "form_repair", key: "test:pytest", text: PYTEST_FACT, section: undefined });
    const { state, eco } = withFacts(seed({ exercised: 9 }), free, seed({ id: "f3", state: "retired", text: "Old." }));
    expect(await eco.inputFor("/r", "implementing", onCfg)).toMatchObject({ manual: [MANUAL_FACT], facts: [PYTEST_FACT] });
    expect(await eco.promoted("/r", ["f1", "f2", "f3", "nope"])).toBe(2);
    expect(state.facts.facts.map((f) => f.state)).toEqual(["promoted", "promoted", "retired"]);
    expect(await eco.inputFor("/r", "implementing", onCfg)).toMatchObject({ guard: expect.anything() });
    const after = await eco.inputFor("/r", "implementing", onCfg);
    expect(after?.manual).toBeUndefined();
    expect(after?.facts).toBeUndefined();
    expect(await noEconomy().promoted("/r", ["f1"])).toBe(0);
  });
});

describe("economy: overhead counted in tokens", () => {
  it("prices an overhead run by its tokens and counts the ones that had none", async () => {
    const { state, store } = fakeStore();
    const eco = economy(store);
    await eco.recordOverhead({ repoPath: "/r", runId: "j1", pack: "loop_judge", cardId: "c1", tokens: { input: 100, output: 10, cached: 0 }, costUsd: 0.01 });
    await eco.recordOverhead({ repoPath: "/r", runId: "j2", pack: "loop_redirect", cardId: "c1", tokens: null, costUsd: 0.02 });
    expect(state.ledger[0]).toMatchObject({ kind: "overhead", effective: 150, tokens: { input: 100, output: 10, cached: 0 }, costUsd: 0.01 });
    expect(state.ledger[1]).toMatchObject({ kind: "overhead", effective: 0, tokens: null, costUsd: 0.02 });
    expect((await eco.status("/r")).cost).toEqual({ exec: 0, overhead: 150, overheadShare: 1, overheadUnpriced: 1 });
  });

  it("takes the proposer's tokens into its overhead record", async () => {
    const { state, store } = fakeStore(editedRuns(3));
    const eco = economy(store);
    await runs(eco, 1, 3);
    const propose: Propose = async () => ({ answer: { facts: [] }, runId: "p1", costUsd: 0.01, tokens: { input: 40, output: 2, cached: 0 } });
    for (let n = 1; n <= 3; n++) await eco.cardClosed("/r", `c${n}`, onCfg, propose);
    expect(state.ledger.at(-1)).toMatchObject({ pack: "fact_propose", effective: 50, tokens: { input: 40, output: 2, cached: 0 } });
  });
});

describe("economy: tool evidence by runtime", () => {
  const stage = () => fakeStore(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, calls(1)])));

  it("folds the evidence of a claude run and of a run whose runtime is not known", async () => {
    const { state, store } = stage();
    const eco = economy(store);
    await eco.afterRun(finished("t0", { pack: "triage", config: pruning, runtime: "claude" }));
    await eco.afterRun(finished("t1", { pack: "triage", config: pruning }));
    expect(state.tools.triage?.units.web?.unusedRuns).toBe(2);
  });

  it("skips the evidence of an eve or jev run, whose skills and agents cannot be seen, and still folds the rest", async () => {
    const { state, store } = stage();
    const eco = economy(store);
    await eco.afterRun(finished("t0", { pack: "triage", config: pruning, runtime: "eve" }));
    await eco.afterRun(finished("t1", { pack: "triage", config: pruning, runtime: "jev" }));
    expect(state.tools).toEqual({});
    expect(state.ledger).toHaveLength(2);
    expect(state.envelopes.triage).toEqual([1, 1]);
  });
});

describe("economy.importRuns", () => {
  const past = [
    { runId: "o1", pack: "implementing" as const, cardId: "c1", outcome: "pass", runtime: "claude" },
    { runId: "o2", pack: "implementing" as const, cardId: "c2", outcome: "fail", runtime: "claude" },
    { runId: "o3", pack: "triage" as const, cardId: "c3", outcome: "pass", runtime: "eve" },
    { runId: "o4", pack: "triage" as const, cardId: "c4", outcome: "pass", runtime: "claude" },
    { runId: "gone", pack: "triage" as const, cardId: "c5", outcome: "pass", runtime: "claude" },
  ];
  const store = () => fakeStore({ o1: calls(4), o2: calls(9), o3: calls(2), o4: calls(3) });
  const importing = (s: ReturnType<typeof fakeStore>["store"]) => economy(s, () => {}, async () => past);

  it("folds the envelope samples of passing runs and the evidence of claude runs, and nothing else", async () => {
    const { state, store: s } = store();
    const count = await importing(s).importRuns("/r", pruning);
    expect(count).toBe(4);
    expect(state.envelopes).toEqual({ implementing: [4], triage: [2, 3] });
    // Only o4 (claude) is evidence for triage: o3 ran on eve.
    expect(state.tools.triage?.units.web?.unusedRuns).toBe(1);
    expect(state.ledger).toEqual([]);
    expect(state.facts.facts).toEqual([]);
    expect(state.digests).toEqual([]);
  });

  it("folds each run once: a second call gives 0, and a run afterRun folded is not folded again", async () => {
    const { state, store: s } = store();
    const eco = importing(s);
    await eco.afterRun(finished("o1", { runtime: "claude" }));
    expect(await eco.importRuns("/r", pruning)).toBe(3);
    expect(await eco.importRuns("/r", pruning)).toBe(0);
    expect(state.envelopes.implementing).toEqual([4]);
  });

  it("skips a run that left no events, and the import is nothing without a source of runs", async () => {
    const { store: s } = fakeStore({ o1: calls(1) });
    expect(await importing(s).importRuns("/r", pruning)).toBe(1);
    expect(await economy(s).importRuns("/r", pruning)).toBe(0);
    expect(await noEconomy().importRuns("/r", pruning)).toBe(0);
  });
});
