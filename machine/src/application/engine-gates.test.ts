import type { BudgetAlert, EngineId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { Credentials } from "../adapters/credentials/index.ts";
import { DISABLED_REASON, EngineBudgetWatch, engineBudgetGate, gatedCredentials, runtimeKillSwitch } from "./engine-gates.ts";

/** Every credential present, except `missing`; `prepare` says which engine it prepared. */
const inner = (missing: EngineId[] = []): Credentials => ({
  check: async (engine) => (missing.includes(engine) ? { available: false, reason: "no Codex login" } : { available: true }),
  prepare: async (engine) => ({ env: { ENGINE: engine }, mounts: [], release: async () => {} }),
});

describe("the runtime kill switch", () => {
  it("makes every engine on a disabled runtime unavailable, saying so, and leaves the rest to their credential", async () => {
    const credentials = gatedCredentials(inner(["codex:luna"]), [runtimeKillSwitch(["jev"])]);
    expect(await credentials.check("jev")).toEqual({ available: false, code: "disabled", reason: DISABLED_REASON });
    expect(DISABLED_REASON).toBe("disabled by MACHINE_DISABLE_RUNTIMES");
    expect(await credentials.check("codex:sol")).toEqual({ available: true });
    expect(await credentials.check("codex:luna")).toEqual({ available: false, reason: "no Codex login" });
    expect(await credentials.check("claude:opus")).toEqual({ available: true });
  });

  it("covers both eve engines, Codex and OpenAI, when eve is off", async () => {
    const credentials = gatedCredentials(inner(), [runtimeKillSwitch(["eve"])]);
    for (const engine of ["codex:sol", "codex:luna", "openai:sol", "openai:luna"] as const) {
      expect(await credentials.check(engine)).toMatchObject({ available: false, code: "disabled" });
    }
    expect(await credentials.check("jev")).toEqual({ available: true });
  });

  it("passes prepare through: the choice already kept a disabled engine from running", async () => {
    const credentials = gatedCredentials(inner(), [runtimeKillSwitch(["eve"])]);
    expect((await credentials.prepare("claude:opus", "/tmp/run")).env).toEqual({ ENGINE: "claude:opus" });
  });
});

describe("the monthly cap per engine", () => {
  /** This month's spend by engine: on the machine, and in one repo. */
  const spend = {
    engineSpendSinceUsd: async (_since: Date, repo?: string) => (repo === "/r/app" ? new Map([["openai:sol", 6]]) : new Map([["openai:sol", 20], ["jev", 1]])),
  };

  it("holds an engine whose own cap or its credential's is reached on the machine, saying how much", async () => {
    const credentials = gatedCredentials(inner(), [engineBudgetGate({ budgets: { openai: 20, jev: 5 }, spend })]);
    expect(await credentials.check("openai:sol")).toEqual({ available: false, code: "budget", reason: "over its monthly budget ($20.00 of $20.00 on openai)" });
    expect(await credentials.check("openai:luna")).toMatchObject({ available: false, code: "budget" });
    expect(await credentials.check("jev")).toEqual({ available: true });
    expect(await credentials.check("codex:sol")).toEqual({ available: true });
  });

  it("holds an engine in a repo whose luna.yaml caps it there, and only there", async () => {
    const repoBudgets = async (repo: string): Promise<Record<string, number>> => (repo === "/r/app" ? { "openai:sol": 5 } : {});
    const credentials = gatedCredentials(inner(), [engineBudgetGate({ budgets: {}, repoBudgets, spend })]);
    expect(await credentials.check("openai:sol", { repo: "/r/app" })).toEqual({ available: false, code: "budget", reason: "over its monthly budget ($6.00 of $5.00 on openai:sol in app)" });
    expect(await credentials.check("openai:sol", { repo: "/r/other" })).toEqual({ available: true });
    expect(await credentials.check("openai:sol")).toEqual({ available: true });
  });

  it("asks for no spend when nothing is capped", async () => {
    let asked = 0;
    const counting = { engineSpendSinceUsd: async () => (asked++, new Map<string, number>()) };
    const credentials = gatedCredentials(inner(), [engineBudgetGate({ budgets: {}, repoBudgets: async () => ({}), spend: counting })]);
    await credentials.check("openai:sol", { repo: "/r/app" });
    expect(asked).toBe(0);
  });
});

describe("EngineBudgetWatch", () => {
  const month = new Map<string, number>();
  const spend = { engineSpendSinceUsd: async (_since: Date, repo?: string) => (repo ? new Map([["openai:sol", (month.get("openai:sol") ?? 0) / 2]]) : new Map(month)) };

  it("raises a budget.alert naming the cap the first time a run takes its spend past 80, 90 and 100%", async () => {
    const alerts: BudgetAlert[] = [];
    const watch = new EngineBudgetWatch({ budgets: { openai: 20, jev: 5 }, spend, onAlert: (alert) => alerts.push(alert) });
    month.clear();
    month.set("openai:sol", 10);
    await watch.afterRun("openai:sol", { taskId: "t1", repo: "/r/app" });
    expect(alerts).toEqual([]);
    month.set("openai:sol", 16.5);
    await watch.afterRun("openai:sol", { taskId: "t1", repo: "/r/app" });
    month.set("openai:luna", 2);
    await watch.afterRun("openai:luna", { taskId: null, repo: null });
    await watch.afterRun("openai:sol", { taskId: "t2", repo: "/r/app" });
    expect(alerts).toEqual([
      { scope: "engine", engine: "openai", taskId: "t1", repo: null, pct: 80, spentUsd: 16.5, limitUsd: 20 },
      { scope: "engine", engine: "openai", taskId: null, repo: null, pct: 90, spentUsd: 18.5, limitUsd: 20 },
    ]);
    month.set("openai:sol", 30);
    await watch.afterRun("openai:sol", { taskId: "t3", repo: null });
    expect(alerts.at(-1)).toMatchObject({ engine: "openai", pct: 100, spentUsd: 32 });
    expect(alerts).toHaveLength(3);
  });

  it("raises a repo's own cap with the repo, against that repo's spend", async () => {
    const alerts: BudgetAlert[] = [];
    const watch = new EngineBudgetWatch({ budgets: {}, repoBudgets: async () => ({ "openai:sol": 5 }), spend, onAlert: (alert) => alerts.push(alert) });
    month.clear();
    month.set("openai:sol", 10);
    await watch.afterRun("openai:sol", { taskId: "t1", repo: "/r/app" });
    expect(alerts).toEqual([{ scope: "engine", engine: "openai:sol", taskId: "t1", repo: "/r/app", pct: 100, spentUsd: 5, limitUsd: 5 }]);
  });

  it("says each engine's spend this month and the cap that binds it: the one reached, else the one with least left", async () => {
    month.clear();
    month.set("openai:sol", 12);
    month.set("openai:luna", 1);
    month.set("jev", 0.5);
    const watch = new EngineBudgetWatch({ budgets: { "openai:sol": 15, openai: 14, jev: 5 }, spend, onAlert: () => {} });
    const standings = await watch.standings();
    expect(standings.get("openai:sol")).toEqual({ spentThisMonthUsd: 13, budgetUsd: 14 });
    expect(standings.get("openai:luna")).toEqual({ spentThisMonthUsd: 13, budgetUsd: 14 });
    expect(standings.get("jev")).toEqual({ spentThisMonthUsd: 0.5, budgetUsd: 5 });
    expect(standings.get("claude:opus")).toEqual({ spentThisMonthUsd: 0, budgetUsd: null });
  });
});
