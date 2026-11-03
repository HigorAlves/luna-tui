import type { EngineId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { Credentials } from "../adapters/credentials/index.ts";
import { DISABLED_REASON, engineBudgetGate, gatedCredentials, runtimeKillSwitch } from "./engine-gates.ts";

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
