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
    expect(runnerFor("backlog")).toBe(stub);
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
