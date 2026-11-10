import { type EconomyConfig, EconomyStatus, type GuardEventRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type LedgerRecord } from "../domain/economy/ledger.ts";
import { type FactsFile } from "../domain/economy/lifecycle.ts";
import { type Digest, keepDigests } from "../domain/economy/observe-run.ts";
import { type EconomyStore, economy, noEconomy } from "./economy.ts";

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
  const state = { envelopes: {} as Record<string, number[]>, ledger: [] as LedgerRecord[], guard: [] as GuardEventRow[], facts: { facts: [], injected: {} } as FactsFile, digests: [] as Digest[] };
  const store: EconomyStore = {
    envelopes: async () => state.envelopes,
    updateEnvelopes: async (_r, change) => void (state.envelopes = change(state.envelopes)),
    appendLedger: async (_r, record) => void state.ledger.push(record),
    ledger: async () => state.ledger,
    appendGuard: async (_r, rows) => void state.guard.push(...rows),
    guard: async () => state.guard,
    facts: async () => state.facts,
    updateFacts: async (_r, change) => void (state.facts = change(state.facts)),
    appendDigest: async (_r, digest) => void (state.digests = keepDigests([...state.digests, digest])),
    digests: async () => state.digests,
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
    expect(status.cost).toEqual({ exec: 100, overhead: 100, overheadShare: 0.5 });
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
