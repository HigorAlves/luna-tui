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
});
