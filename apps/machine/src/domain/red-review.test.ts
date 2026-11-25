import { describe, expect, it } from "vitest";

import { NOT_TAUTOLOGICAL_PROBLEM, RIGHT_REASON_PROBLEM, redReviewLine } from "./red-review.ts";

// DISC-53's S17 and S5: the writer kept both tests unchanged when told only "it asserts its own setup".
const s17 = { id: "S17", title: "only that manager's visible participants", then: "only that manager's visible participants are returned" };
const s5 = { id: "S5", title: "legacy keys are a subset", then: "the legacy keys are a subset of the DTO keys for all 20 operations" };

describe("redReviewLine: what the test writer is told to change", () => {
  it("names the outcome to assert for a test that would pass without the behaviour, and says a status or shape check is not it", () => {
    const line = redReviewLine(s17, NOT_TAUTOLOGICAL_PROBLEM);
    expect(line).toMatch(/^S17: /);
    expect(line).toContain("only that manager's visible participants are returned");
    expect(line).toMatch(/status code|shape/);
    expect(line).not.toMatch(/asserts its own setup/);
  });

  it("says to write the fixture a test reads when it fails on a missing fixture, and keeps the judge's words for any other wrong reason", () => {
    expect(redReviewLine(s5, RIGHT_REASON_PROBLEM, "AssertionError: frozen legacy fixtures exist: expected false to be true")).toMatch(/S5: .*fixture.*write it/i);
    expect(redReviewLine(s5, RIGHT_REASON_PROBLEM, "TypeError: foo is not a function")).toBe(`S5: ${RIGHT_REASON_PROBLEM}`);
  });

  it("falls back to the title, and passes any other problem through", () => {
    expect(redReviewLine({ id: "S1", title: "the cart totals" }, NOT_TAUTOLOGICAL_PROBLEM)).toContain("the cart totals");
    expect(redReviewLine({ id: "S1", title: "t" }, "no red reported")).toBe("S1: no red reported");
  });
});
