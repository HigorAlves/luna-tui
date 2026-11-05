import { describe, expect, it } from "vitest";

import { type Item, costOfDelayOf, costOfDoingOf, rankBacklog } from "./backlog.ts";

const NOW = new Date("2026-11-05T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const item = (id: string, over: Partial<Item> = {}): Item => ({ id, title: id, scores: { who: 2, what: 2, impact: 2, time: 2, demand: 1 }, size: "S", demand: 1, addedAt: day(1), assessedAt: day(1), ...over });

describe("cost of delay and cost of doing", () => {
  it("delay is urgency (time) plus compounding (mean of who, what, impact), plus a quarter per extra report", () => {
    expect(costOfDelayOf(item("a", { scores: { who: 3, what: 3, impact: 3, time: 3, demand: 1 } }))).toBe(6);
    expect(costOfDelayOf(item("b"))).toBe(4);
    expect(costOfDelayOf(item("c", { scores: { who: 3, what: 3, impact: 3, time: 3, demand: 1 }, demand: 5 }))).toBe(7);
  });
  it("doing comes from the size: XS 3, S 4, M 6, L 8, XL 9", () => {
    expect((["XS", "S", "M", "L", "XL"] as const).map((size) => costOfDoingOf(item("x", { size })))).toEqual([3, 4, 6, 8, 9]);
  });
});

describe("ranking the backlog", () => {
  const top = { who: 3, what: 3, impact: 3, time: 3, demand: 1 };
  const items = [
    item("old-tie", { scores: top, size: "M", addedAt: day(20), assessedAt: day(3) }),
    item("best", { scores: top, size: "XS" }),
    item("new-tie", { scores: top, size: "M", addedAt: day(2), assessedAt: day(2) }),
    item("loud", { scores: top, size: "M", demand: 5 }),
    item("plain"),
  ];
  it("orders by cost of delay over cost of doing, ties by age (older first)", () => {
    const ranked = rankBacklog(items, { now: NOW, staleDays: 14 });
    expect(ranked.map((r) => [r.id, r.score])).toEqual([["best", 2], ["loud", 1.167], ["old-tie", 1], ["new-tie", 1], ["plain", 1]]);
  });
  it("flags an item not assessed for the stale days", () => {
    const ranked = rankBacklog([item("fresh", { assessedAt: day(14) }), item("stale", { assessedAt: day(15) })], { now: NOW, staleDays: 14 });
    expect(Object.fromEntries(ranked.map((r) => [r.id, r.stale]))).toEqual({ fresh: false, stale: true });
  });
  it("does not change the items it was given", () => {
    const copy = [...items];
    rankBacklog(items, { now: NOW, staleDays: 14 });
    expect(items).toEqual(copy);
  });
});
