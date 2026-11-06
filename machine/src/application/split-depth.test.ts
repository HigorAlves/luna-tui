import { describe, expect, it } from "vitest";

import { splitDepth } from "./split-depth.ts";

type Row = Parameters<typeof splitDepth>[1];
const rows = {
  root: { card: null, source: null },
  child: { card: { splitFrom: "root" }, source: null },
  grandchild: { card: { splitFrom: "child" }, source: null },
  loop: { card: { splitFrom: "loop" }, source: null },
  orphan: { card: { splitFrom: "missing" }, source: null },
} as unknown as Record<string, Row>;
const get = async (id: string) => rows[id] ?? null;

describe("splitDepth", () => {
  it("is 1 for a card nothing was split into, and one more for each card it was split from", async () => {
    expect(await splitDepth(get, rows.root!)).toBe(1);
    expect(await splitDepth(get, rows.child!)).toBe(2);
    expect(await splitDepth(get, rows.grandchild!)).toBe(3);
  });

  it("stops at a card that is gone and at a loop, counting what it saw", async () => {
    expect(await splitDepth(get, rows.orphan!)).toBe(2);
    expect(await splitDepth(get, rows.loop!)).toBeGreaterThanOrEqual(2);
    expect(await splitDepth(get, rows.loop!)).toBeLessThanOrEqual(11);
  });

  it("counts the tickets above a card's own ticket when its card has no splitFrom: a child ticket's card is depth 2, a grandchild's 3", async () => {
    expect(await splitDepth(get, rows.root!, async () => 0)).toBe(1);
    expect(await splitDepth(get, rows.root!, async () => 1)).toBe(2);
    expect(await splitDepth(get, rows.root!, async () => 2)).toBe(3);
    expect(await splitDepth(get, rows.child!, async () => 1)).toBe(2);
    expect(await splitDepth(get, rows.root!, async () => Promise.reject(new Error("unreadable")))).toBe(1);
  });
});
