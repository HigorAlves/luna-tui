import { describe, expect, it } from "vitest";

import { verifySteps } from "./verify-order.ts";

// What has happened in a verifying run so far, and what comes next. The diagram's order: the review first, the suite only when no blocker stands.
describe("the order of Verify", () => {
  it("reviews before it runs anything of the suite", () => {
    expect(verifySteps({ env: "matched", review: null, blockers: 0, checks: null })).toBe("review");
  });

  it("stops at a blocker without running the suite", () => {
    expect(verifySteps({ env: "matched", review: "done", blockers: 2, checks: null })).toBe("fail");
  });

  it("runs the suite once the review found no blocker, then reports", () => {
    expect(verifySteps({ env: "matched", review: "done", blockers: 0, checks: null })).toBe("checks");
    expect(verifySteps({ env: "matched", review: "done", blockers: 0, checks: "green" })).toBe("report");
    expect(verifySteps({ env: "matched", review: "done", blockers: 0, checks: "red" })).toBe("fail");
  });

  it("fails on an environment that does not match before the review is spent", () => {
    expect(verifySteps({ env: "mismatch", review: null, blockers: 0, checks: null })).toBe("fail");
  });
});
