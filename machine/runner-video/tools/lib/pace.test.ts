import { describe, expect, it } from "vitest";

import { durationFor, plannedMs } from "./pace.ts";

const timeline = { scenes: [{ id: "hook", start: 0, end: 4 }, { id: "add", start: 4, end: 30.5 }] };

describe("plannedMs", () => {
  it("is the scene's end minus its start, in milliseconds", () => {
    expect(plannedMs(timeline, "hook")).toBe(4000);
    expect(plannedMs(timeline, "add")).toBe(26_500);
  });

  it("refuses a scene the timeline does not have", () => {
    expect(() => plannedMs(timeline, "nope")).toThrow(/no scene "nope"/);
  });
});

describe("durationFor", () => {
  const narration = { scenes: [{ id: "add", durationS: 12.3456 }] };

  it("uses the narration clip when there is one for the scene, else the timeline's plan", () => {
    expect(durationFor("add", { narration, timeline })).toBe(12_346);
    expect(durationFor("hook", { narration, timeline })).toBe(4000);
    expect(durationFor("add", { narration: null, timeline })).toBe(26_500);
  });

  it("throws when neither source has the scene", () => {
    expect(() => durationFor("zz", { narration, timeline })).toThrow(/no narration or plan for scene "zz"/);
    expect(() => durationFor("zz", { narration: null, timeline: null })).toThrow(/no narration or plan/);
  });
});
