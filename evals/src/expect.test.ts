import { describe, expect, it } from "vitest";

import { Check, Expect, resolvePath, runCheck } from "./expect.ts";

const answer = {
  kind: "brief",
  summary: "Fix formatPrice in src/cart.js to use toFixed(2)",
  slices: [{ title: "fix", touchpoints: ["src/cart.js"] }],
  items: [
    { id: "m1", priority: "P0", expectsReply: true },
    { id: "m2", priority: "P3", expectsReply: false },
    { id: "m3", priority: "P3", expectsReply: false },
  ],
};
const check = (raw: unknown) => runCheck(answer, Check.parse(raw));

describe("resolvePath", () => {
  it("walks keys, every element, a selected element and an index", () => {
    expect(resolvePath(answer, "")).toEqual([answer]);
    expect(resolvePath(answer, "kind")).toEqual(["brief"]);
    expect(resolvePath(answer, "items[].priority")).toEqual(["P0", "P3", "P3"]);
    expect(resolvePath(answer, "items[id=m2].priority")).toEqual(["P3"]);
    expect(resolvePath(answer, "items[expectsReply=true].id")).toEqual(["m1"]);
    expect(resolvePath(answer, "slices[0].touchpoints[]")).toEqual(["src/cart.js"]);
    expect(resolvePath(answer, "missing.deeper")).toEqual([]);
    expect(resolvePath(answer, "items[id=nope].priority")).toEqual([]);
  });
});

describe("runCheck", () => {
  it("equals: every value at the path, and at least one", () => {
    expect(check({ kind: "equals", path: "kind", value: "brief" })).toEqual({ check: 'kind = "brief"', pass: true, detail: null });
    expect(check({ kind: "equals", path: "items[].priority", value: "P3" })).toMatchObject({ pass: false, detail: 'found "P0"' });
    expect(check({ kind: "equals", path: "items[id=x].priority", value: "P3" })).toMatchObject({ pass: false, detail: "nothing there" });
  });

  it("oneOf: each value is one of the allowed", () => {
    expect(check({ kind: "oneOf", path: "items[id=m2].priority", values: ["P2", "P3"] }).pass).toBe(true);
    expect(check({ kind: "oneOf", path: "items[].priority", values: ["P2", "P3"] })).toMatchObject({ pass: false, detail: 'found "P0"' });
  });

  it("count: an array's length, or the matches of a selector, within min..max", () => {
    expect(check({ kind: "count", path: "slices", min: 1, max: 4 }).pass).toBe(true);
    expect(check({ kind: "count", path: "items[priority=P3]", min: 2, max: 2 }).pass).toBe(true);
    expect(check({ kind: "count", path: "items", max: 2 })).toMatchObject({ pass: false, detail: "found 3", check: "items count 0..2" });
    expect(check({ kind: "count", path: "questions", min: 1 })).toMatchObject({ pass: false, detail: "found 0" });
  });

  it("mentions and avoids: words in the text at the path, case-insensitively", () => {
    expect(check({ kind: "mentions", path: "summary", words: ["formatprice", "toFixed(2)"] }).pass).toBe(true);
    expect(check({ kind: "mentions", path: "summary", words: ["formatPrice", "describeCart"] })).toMatchObject({ pass: false, detail: "missing describeCart" });
    expect(check({ kind: "mentions", path: "summary", words: ["nope", "cart.js"], any: true }).pass).toBe(true);
    expect(check({ kind: "mentions", words: ["src/cart.js"] }).pass).toBe(true);
    expect(check({ kind: "avoids", words: [".golden", "patch"] }).pass).toBe(true);
    expect(check({ kind: "avoids", path: "summary", words: ["FORMATPRICE"] })).toMatchObject({ pass: false, detail: "found FORMATPRICE" });
  });
});

describe("Expect", () => {
  it("needs a rubric, defaults the checks, and rejects an unknown check", () => {
    expect(Expect.parse({ schema: 1, rubric: "r" })).toEqual({ schema: 1, rubric: "r", checks: [] });
    expect(Expect.safeParse({ schema: 1 }).success).toBe(false);
    expect(Expect.safeParse({ schema: 1, rubric: "r", checks: [{ kind: "regex", path: "a" }] }).success).toBe(false);
    expect(Expect.safeParse({ schema: 1, rubric: "r", outcome: "maybe" }).success).toBe(false);
  });
});
