import { describe, expect, it } from "vitest";

import { Timeline, checkTimeline } from "./timeline.ts";

/** A 60-second narrated walkthrough: a hook card, two demo scenes (one per approved scenario), an end card. */
const valid: Timeline = {
  meta: { w: 1920, h: 1080, fps: 30, dur: 60, clock: "voice", title: "Discounts in the cart", commit: "abc1234" },
  scenes: [
    { id: "hook", title: "Discounts in the cart", kind: "card", start: 0, end: 4, text: "The cart now shows every discount as you add it.", card: { heading: "Discounts in the cart", role: "hook" } },
    { id: "add-coupon", title: "A coupon applied twice counts once", kind: "demo", start: 4, end: 30, text: "Apply the same coupon twice. The total drops once, and the second click changes nothing." },
    { id: "total", title: "The cart shows the discounted total", kind: "demo", start: 30, end: 56, text: "The total line shows the discount and the final price side by side." },
    { id: "end", title: "That is the change", kind: "card", start: 56, end: 60, text: "That is the change.", card: { heading: "Shipped", role: "end" } },
  ],
  texts: [{ role: "hook", text: "Discounts in the cart", px: 96, from: 0, to: 4 }],
  terms: ["coupon"],
  facts: [],
};
const scenarios = ["A coupon applied twice counts once", "The cart shows the discounted total"];

describe("checkTimeline", () => {
  it("accepts a contiguous timeline under four minutes with a hook by three seconds and one demo scene per approved scenario", () => {
    expect(checkTimeline(valid, { scenarios })).toEqual({ errors: [], warnings: [] });
  });

  it("names the rule each error breaks: a gap between scenes, a missing scenario, a late or small hook, a film over four minutes", () => {
    const gap = { ...valid, scenes: valid.scenes.map((s) => (s.id === "total" ? { ...s, start: 31 } : s)) };
    expect(checkTimeline(gap, { scenarios }).errors.join("\n")).toMatch(/gap|contiguous/i);
    const missing = checkTimeline(valid, { scenarios: [...scenarios, "Removing a coupon restores the total"] }).errors.join("\n");
    expect(missing).toMatch(/Removing a coupon restores the total/);
    const late = { ...valid, texts: [{ ...valid.texts[0]!, from: 3.5, to: 6 }] };
    expect(checkTimeline(late, { scenarios }).errors.join("\n")).toMatch(/hook.*3/i);
    const small = { ...valid, texts: [{ ...valid.texts[0]!, px: 60 }] };
    expect(checkTimeline(small, { scenarios }).errors.join("\n")).toMatch(/84/);
    const long = { ...valid, meta: { ...valid.meta, dur: 250 }, scenes: valid.scenes.map((s) => (s.id === "end" ? { ...s, end: 250 } : s)) };
    expect(checkTimeline(long, { scenarios }).errors.join("\n")).toMatch(/240/);
  });

  it("accepts only plain scene ids: they name files and ffmpeg filter pads", () => {
    const odd = { ...valid, scenes: valid.scenes.map((s) => (s.id === "total" ? { ...s, id: "a];movie=/etc/passwd[x" } : s)) };
    expect(Timeline.safeParse(odd).success).toBe(false);
    expect(Timeline.safeParse(valid).success).toBe(true);
  });

  it("makes an uncited number on screen an error unless it is labelled SCHEMATIC", () => {
    const uncited = { ...valid, texts: [...valid.texts, { role: "term" as const, text: "Saves 30%", px: 56, from: 10, to: 14 }] };
    expect(checkTimeline(uncited, { scenarios }).errors.join("\n")).toMatch(/30%|cite|fact/i);
    const cited = { ...uncited, facts: [{ claim: "Saves 30% on the sample cart", source: "qa-manifest.json: total row" }] };
    expect(checkTimeline(cited, { scenarios }).errors).toEqual([]);
    const labelled = { ...valid, texts: [...valid.texts, { role: "term" as const, text: "Saves 30% (SCHEMATIC)", px: 56, from: 10, to: 14 }] };
    expect(checkTimeline(labelled, { scenarios }).errors).toEqual([]);
  });
});

describe("checkTimeline with a budget", () => {
  it("holds the film to the budget it is given", () => {
    expect(checkTimeline(valid, { scenarios, maxS: 45 }).errors.join("\n")).toMatch(/60s, over the 45s limit/);
    expect(checkTimeline(valid, { scenarios, maxS: 90 }).errors).toEqual([]);
    expect(checkTimeline({ ...valid, meta: { ...valid.meta, dur: 250 } }, { scenarios }).errors.join("\n")).toMatch(/over the 240s limit/);
  });
});
