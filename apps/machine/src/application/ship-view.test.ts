import { describe, expect, it } from "vitest";

import { emptyCursor } from "./ship-cursor.ts";
import { shipViewOf, viewSnapshot } from "./ship-view.ts";

const HEAD = "a".repeat(40);
const facts = (over: Record<string, unknown> = {}) => ({
  head: HEAD,
  readiness: { ready: false, blockers: ["CI is running"], canAutoMerge: false, reason: "not ready: CI is running", needsShipApproval: false, checklist: [{ id: "ci" as const, ok: false, detail: "CI is running" }, { id: "pack" as const, ok: true, detail: "the pack is complete" }] },
  review: { required: true as const, by: "a ruleset" },
  ...over,
});

describe("shipViewOf: what the board shows of a watched PR", () => {
  it("is null for a card with no cursor", () => {
    expect(shipViewOf(null)).toBeNull();
  });

  it("is the PR with no readiness yet when the watch has not read the facts", () => {
    expect(shipViewOf(emptyCursor({ slug: "o/a", number: 3 }))).toMatchObject({
      pr: { number: 3, url: "https://github.com/o/a/pull/3" },
      head: null,
      ready: false,
      checklist: [],
      autoMerge: { allowed: false },
      review: { required: null, by: null },
      fixRounds: 0,
      queued: false,
      quietSince: null,
      lastEvent: null,
    });
  });

  it("carries the checklist, the merge rule's answer, the review rule, the clocks and the last event class", () => {
    const cursor = { ...emptyCursor({ slug: "o/a", number: 3 }), fixRounds: 2, queued: true, lastActivityAt: "2026-11-04T10:00:00.000Z", lastEvent: { class: "review_comment", at: "2026-11-04T11:00:00.000Z" }, view: viewSnapshot(facts() as never, "2026-11-04T12:00:00.000Z") };
    expect(shipViewOf(cursor)).toEqual({
      pr: { slug: "o/a", number: 3, url: "https://github.com/o/a/pull/3" },
      head: HEAD,
      ready: false,
      checklist: [{ id: "ci", ok: false, detail: "CI is running" }, { id: "pack", ok: true, detail: "the pack is complete" }],
      autoMerge: { allowed: false, reason: "not ready: CI is running" },
      review: { required: true, by: "a ruleset" },
      fixRounds: 2,
      queued: true,
      quietSince: "2026-11-04T10:00:00.000Z",
      lastEvent: { class: "review_comment", at: "2026-11-04T11:00:00.000Z" },
      at: "2026-11-04T12:00:00.000Z",
    });
  });

  it("an unreadable review rule is null, and every text a PR can shape is flattened and capped", () => {
    const hostile = "<!-- x --> @bo closes #12 " + "y".repeat(500);
    const view = shipViewOf({ ...emptyCursor({ slug: "o/a", number: 3 }), view: viewSnapshot(facts({ review: { required: null, why: hostile }, readiness: { ...facts().readiness, reason: hostile, checklist: [{ id: "ci", ok: false, detail: hostile }] } }) as never, "t") })!;
    expect(view.review).toEqual({ required: null, by: null });
    for (const text of [view.autoMerge.reason, view.checklist[0]!.detail]) {
      expect(text).not.toContain("<");
      expect(text).not.toMatch(/@(?=[A-Za-z])/);
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });

  it("holds no reviewer text and no thread: only these keys", () => {
    const view = shipViewOf({ ...emptyCursor({ slug: "o/a", number: 3 }), seen: ["review_comment:1"], threads: { T1: { replies: 1, lastAt: "t" } } })!;
    expect(Object.keys(view).sort()).toEqual(["at", "autoMerge", "checklist", "fixRounds", "head", "lastEvent", "pr", "queued", "quietSince", "ready", "review"]);
    expect(JSON.stringify(view)).not.toContain("review_comment:1");
  });
});
