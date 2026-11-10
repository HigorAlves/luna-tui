import { type EconomyConfig, type GuardEventRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type LedgerRecord } from "../domain/economy/ledger.ts";
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
  const state = { envelopes: {} as Record<string, number[]>, ledger: [] as LedgerRecord[], guard: [] as GuardEventRow[] };
  const store: EconomyStore = {
    envelopes: async () => state.envelopes,
    updateEnvelopes: async (_r, change) => void (state.envelopes = change(state.envelopes)),
    appendLedger: async (_r, record) => void state.ledger.push(record),
    ledger: async () => state.ledger,
    appendGuard: async (_r, rows) => void state.guard.push(...rows),
    guard: async () => state.guard,
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
