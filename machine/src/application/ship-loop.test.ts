import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type ShippedEvent, shippedEvent, shippedStream, shippedSummary } from "./ship-loop.ts";

const pack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
  summary: "s",
  format: "video",
  scenarios: [],
  findings: [],
  outOfMap: [],
  risk: "low",
  rollback: "r",
  howToVerify: "Open the cart and press Export.",
  commitSha: "9c1f0e2a7b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f",
  media: [
    { kind: "video", label: "Walkthrough", url: "https://github.com/o/a/releases/download/luna-evidence/t1.mp4" },
    { kind: "screenshot", label: "Cart", url: "/Users/me/.luna/evidence/t1/cart.png" },
  ],
  at: "2026-11-04T00:00:00.000Z",
  ...over,
});

describe("shippedEvent", () => {
  it("is built from the task's pack and the merge, with web urls only and no host path", () => {
    const event = shippedEvent({ title: "Export CSV", evidence: pack() }, { merged: { sha: "m".repeat(40), by: "machine" }, prUrl: "https://github.com/o/a/pull/3", number: 3 });
    expect(event).toEqual({
      title: "Export CSV",
      prUrl: "https://github.com/o/a/pull/3",
      number: 3,
      mergedSha: "m".repeat(40),
      by: "machine",
      format: "video",
      howToVerify: "Open the cart and press Export.",
      media: [{ kind: "video", label: "Walkthrough", url: "https://github.com/o/a/releases/download/luna-evidence/t1.mp4" }],
    });
  });

  it("has no pack to draw on without one, and is nothing without a merge", () => {
    expect(shippedEvent({ title: "t", evidence: null }, { merged: { sha: null, by: "person" }, prUrl: "u", number: 1 })).toMatchObject({ format: null, howToVerify: null, media: [], by: "person" });
    expect(shippedEvent({ title: "t", evidence: null }, { prUrl: "u", number: 1 })).toBeNull();
  });
});

describe("shippedSummary", () => {
  const event: ShippedEvent = { title: "Export CSV", prUrl: "https://github.com/o/a/pull/3", number: 3, mergedSha: "9c1f0e2a7b3d4e5f", by: "person", format: "video", howToVerify: "Open the cart and press Export.", media: [{ kind: "video", label: "Walkthrough", url: "https://x/w.mp4" }] };

  it("says what shipped, where, how to check it and the evidence", () => {
    expect(shippedSummary(event)).toBe("Shipped: Export CSV — https://github.com/o/a/pull/3 (9c1f0e2). How to verify: Open the cart and press Export. Evidence: video; Walkthrough (https://x/w.mp4).");
  });

  it("leaves out what it does not have, flattens model text, and never prints a local path", () => {
    const text = shippedSummary({ ...event, mergedSha: null, format: null, media: [{ kind: "x", label: "Local", url: "/Users/me/a.png" }], howToVerify: "Ask @bob, see #12\nthen <b>go</b>" });
    expect(text).not.toMatch(/@bob|#12|\n|<b>|\/Users/);
    expect(text).toBe("Shipped: Export CSV — https://github.com/o/a/pull/3. How to verify: Ask @​bob, see #​12 then &lt;b&gt;go&lt;/b&gt;.");
  });
});

describe("shippedStream", () => {
  it("makes the stream message from a logged event, and nothing from any other", () => {
    const payload = { title: "t", prUrl: "u", number: 3, mergedSha: null, by: "machine", format: null, howToVerify: null, media: [] };
    expect(shippedStream({ taskId: "t1", kind: "task.shipped", payload, at: new Date("2026-11-04T12:00:00Z") })).toEqual({
      type: "task.shipped",
      shipped: { id: "t1", title: "t", prUrl: "u", number: 3, mergedSha: null, format: null, howToVerify: null, media: [], at: "2026-11-04T12:00:00.000Z" },
    });
    expect(shippedStream({ taskId: "t1", kind: "transition", payload, at: new Date() })).toBeNull();
    expect(shippedStream({ taskId: "t1", kind: "task.shipped", payload: { nope: 1 }, at: new Date() })).toBeNull();
  });
});
