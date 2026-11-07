import { describe, expect, it } from "vitest";

import { EXCERPT_CHARS, testExcerpt } from "./test-excerpt.ts";

const file = ["import { it } from 'vitest';", "// @scenario:S1", "it('one', () => {", "  expect(1).toBe(2);", "});", "// @scenario:S10", "it('ten', () => {", "  expect(10).toBe(11);", "});"].join("\n");

describe("testExcerpt", () => {
  it("cuts from the scenario's tag to the next scenario's", () => {
    expect(testExcerpt(file, "S1")).toBe("// @scenario:S1\nit('one', () => {\n  expect(1).toBe(2);\n});");
  });
  it("does not take S10 for S1", () => {
    expect(testExcerpt(file, "S10")).toContain("expect(10)");
    expect(testExcerpt(file, "S10")).not.toContain("expect(1)");
  });
  it("gives the head of the file when no line carries the tag", () => {
    expect(testExcerpt(file, "S7")).toBe(file);
  });
  it("is capped", () => {
    expect(testExcerpt(`// @scenario:S1\n${"x".repeat(9000)}`, "S1")).toHaveLength(EXCERPT_CHARS);
  });
});
