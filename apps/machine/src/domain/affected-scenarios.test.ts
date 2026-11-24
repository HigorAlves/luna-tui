import { describe, expect, it } from "vitest";

import { affectedScenarios } from "./affected-scenarios.ts";

const known = [{ id: "s1", text: "exports a csv", result: "pass" }, { id: "s2", text: "empty cart", result: "pass" }, { id: "s3", text: "big file", result: "fail" }];

describe("affectedScenarios", () => {
  it("is the named ids that are approved scenarios, plus those whose test file the fix changed; unknown ids are dropped", () => {
    const out = affectedScenarios({ named: ["s1", "ghost"], changed: ["test/cart.test.ts"], tests: [{ scenario: "s2", file: "test/cart.test.ts" }, { scenario: "s3", file: "test/big.test.ts" }], known });
    expect(out).toEqual([{ id: "s1", text: "exports a csv", result: "pass" }, { id: "s2", text: "empty cart", result: "pass" }]);
  });
  it("is empty when nothing is named and no test file changed", () => {
    expect(affectedScenarios({ named: [], changed: ["src/a.ts"], tests: [{ scenario: "s1", file: "test/a.test.ts" }], known })).toEqual([]);
  });
  it("names each scenario once and ignores a test with no file", () => {
    expect(affectedScenarios({ named: ["s1", "s1"], changed: ["t.ts"], tests: [{ scenario: "s1", file: "t.ts" }, { scenario: "s2", file: null }], known }).map((s) => s.id)).toEqual(["s1"]);
  });
});
