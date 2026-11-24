import { LOOP_STUCK } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { loopStop } from "./stop.ts";

const error = `${LOOP_STUCK}: the same test fails after each edit, the same failure 4 times over 31 calls`;

describe("loopStop", () => {
  it("is null for a failure the guard did not cause", () => {
    expect(loopStop("timed out after 30 minutes", [])).toBeNull();
    expect(loopStop(undefined, [])).toBeNull();
  });

  it("reads the stop event the run logged, under either kind", () => {
    const payload = { action: "stop", calls: 31, cause: "edits that do not change the failure", failure: "abc1234567" };
    for (const kind of ["economy.guard", "stage.economy.guard"]) {
      expect(loopStop(error, [{ at: "t", kind, payload }])).toEqual({ cause: "edits that do not change the failure", failure: "abc1234567", calls: 31 });
    }
  });

  it("reads the error text when no stop event came with the result", () => {
    expect(loopStop(error, [{ at: "t", kind: "economy.guard", payload: { action: "gate", calls: 9 } }])).toEqual({ cause: "the same test fails after each edit", calls: 31 });
  });

  it("still says it was the guard when the text has no numbers", () => {
    expect(loopStop(`${LOOP_STUCK}: going round in circles`, [])).toEqual({ cause: "going round in circles", calls: 0 });
  });

  it("ignores a stop event whose cause is not a bounded string, and cuts the cause it reads from the error", () => {
    const payload = { action: "stop", calls: 31, cause: "<img src=x onerror=y>", failure: "abc1234567" };
    expect(loopStop(error, [{ at: "t", kind: "economy.guard", payload }])).toEqual({ cause: "the same test fails after each edit", calls: 31 });
    const long = `${LOOP_STUCK}: ${"x".repeat(300)}, the same failure 4 times over 31 calls`;
    expect(loopStop(long, [])?.cause).toHaveLength(60);
  });
});
