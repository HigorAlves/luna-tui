import { describe, expect, it, vi } from "vitest";

import { buildRunnerFor } from "./stages.ts";

describe("buildRunnerFor", () => {
  it("routes delivering, verifying and shipping to the always-real runners, everything else to the stub or the real map", () => {
    const real = { triage: vi.fn(), implementing: vi.fn() };
    const stub = vi.fn();
    const runnerFor = buildRunnerFor({
      real,
      realDeliverRunner: "deliver" as never,
      realVerifyRunner: "verify" as never,
      shipRunner: "ship" as never,
      stubRunnerFor: () => stub,
    });
    expect(runnerFor("delivering")).toBe("deliver");
    expect(runnerFor("verifying")).toBe("verify");
    expect(runnerFor("shipping")).toBe("ship");
    expect(runnerFor("triage")).toBe(real.triage);
    expect(runnerFor("draft")).toBe(stub);
  });

  it("prefers the real map's shipping runner (the memory-review wrapper) over the stub ship runner", () => {
    const shippingRunner = vi.fn();
    const runnerFor = buildRunnerFor({
      real: { shipping: shippingRunner },
      realDeliverRunner: "deliver" as never,
      realVerifyRunner: "verify" as never,
      shipRunner: "ship" as never,
      stubRunnerFor: () => vi.fn(),
    });
    expect(runnerFor("shipping")).toBe(shippingRunner);
  });
});

describe("buildRunnerFor on a PR task", () => {
  const ctx = (route: string, stage: string) => ({ task: { route }, stage }) as never;

  it("sends the shared stages to the PR runners by route and leaves feature tasks alone", async () => {
    const calls: string[] = [];
    const named = (name: string) => async () => {
      calls.push(name);
      return { outcome: "pass" as const };
    };
    const runnerFor = buildRunnerFor({
      real: { shipping: named("memory-ship"), reviewing: named("review"), addressing: named("address") },
      realDeliverRunner: named("deliver"),
      realVerifyRunner: named("verify"),
      shipRunner: named("ship"),
      stubRunnerFor: () => named("stub"),
      pr: { checksOnlyVerifyRunner: named("checks"), followUpRunner: named("follow-up"), postVerdictRunner: named("verdict") },
    });
    await runnerFor("verifying")(ctx("ci_fix", "verifying"));
    await runnerFor("verifying")(ctx("address", "verifying"));
    await runnerFor("verifying")(ctx("feature", "verifying"));
    await runnerFor("delivering")(ctx("address", "delivering"));
    await runnerFor("delivering")(ctx("ci_fix", "delivering"));
    await runnerFor("shipping")(ctx("review", "shipping"));
    await runnerFor("shipping")(ctx("feature", "shipping"));
    await runnerFor("reviewing")(ctx("review", "reviewing"));
    await runnerFor("addressing")(ctx("address", "addressing"));
    expect(calls).toEqual(["checks", "checks", "verify", "follow-up", "deliver", "verdict", "memory-ship", "review", "address"]);
  });
});
