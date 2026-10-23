import { describe, expect, it } from "vitest";

import { lockedFilesTouched } from "./locked-files.ts";

describe("lockedFilesTouched", () => {
  it("flags a modified existing test file", () => {
    const diff = "M\tsrc/cart.js\nM\ttest/cart.test.js\n";
    expect(lockedFilesTouched(diff)).toEqual(["test/cart.test.js"]);
  });

  it("flags a deleted test file", () => {
    const diff = "D\ttest/cart.test.js\n";
    expect(lockedFilesTouched(diff)).toEqual(["test/cart.test.js"]);
  });

  it("does not flag a brand-new test file (status A)", () => {
    const diff = "A\ttest/new-thing.test.js\n";
    expect(lockedFilesTouched(diff)).toEqual([]);
  });

  it("does not flag non-test files", () => {
    const diff = "M\tsrc/cart.js\nM\tREADME.md\n";
    expect(lockedFilesTouched(diff)).toEqual([]);
  });

  it("recognizes common test path conventions", () => {
    const diff = [
      "M\tsrc/__tests__/cart.js",
      "M\tspec/cart_spec.rb",
      "M\ttests/test_cart.py",
      "M\tsrc/cart.test.ts",
      "M\tsrc/cart_test.go",
    ].join("\n");
    expect(lockedFilesTouched(diff)).toHaveLength(5);
  });

  it("handles an empty diff", () => {
    expect(lockedFilesTouched("")).toEqual([]);
  });

  it("flags a renamed-away test file (status R, two tab-separated paths)", () => {
    const diff = "R100\ttest/cart.test.js\tsrc/cart-helpers.js\n";
    expect(lockedFilesTouched(diff)).toEqual(["test/cart.test.js"]);
  });

  it("flags a snapshot file with more than one extension segment", () => {
    const diff = "M\tsrc/__snapshots__/cart.test.ts.snap\n";
    expect(lockedFilesTouched(diff)).toEqual(["src/__snapshots__/cart.test.ts.snap"]);
  });

  it("flags a prefix-style test file with no directory or leading separator", () => {
    const diff = "M\ttest_cart.py\nM\ttest.js\n";
    expect(lockedFilesTouched(diff)).toEqual(["test_cart.py", "test.js"]);
  });

  it("does not flag a file that merely contains \"test\" as a substring", () => {
    const diff = "M\tsrc/contest.ts\nM\tsrc/attests.js\nM\tsrc/latency.js\n";
    expect(lockedFilesTouched(diff)).toEqual([]);
  });
});
