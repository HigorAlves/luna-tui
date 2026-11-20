import { MAX_CAPTURES } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { capturePlan } from "./parity-plan.ts";

const desktop = { width: 1440, height: 900 };
const designed = (state: string, nodeId: string | null = "1:1") => ({ state, nodeId, suggestion: null });
const frame = (id: string, states: unknown[], viewport: { width: number; height: number } | null = desktop) => ({ id, name: `frame ${id}`, viewport, states });
const spec = {
  frames: [
    frame("12:34", [designed("default"), designed("hover")]),
    frame("12:40", [designed("default")], { width: 390, height: 844 }),
    frame("20:1", [designed("default")]),
  ],
} as never;
const keys = (plan: ReturnType<typeof capturePlan>) => plan.targets.map((t) => `${t.scenario}/${t.viewport.name}-${t.state}`);

describe("capturePlan", () => {
  it("captures each browser scenario at the viewport and states of the frame it cites", () => {
    const plan = capturePlan([{ id: "S1", title: "pay", layer: "e2e", frame_ref: "12:34" }, { id: "S2", title: "m", layer: "e2e", frame_ref: "12:40" }, { id: "S3", title: "unit", layer: "unit", frame_ref: "20:1" }] as never, spec);
    expect(keys(plan)).toEqual(["S1/1440x900-default", "S1/1440x900-hover", "S2/390x844-default"]);
    expect(plan.targets[0]).toMatchObject({ scenario: "S1", frame: "12:34", state: "default", viewport: { name: "1440x900", width: 1440, height: 900 } });
  });
  it("lists the spec frames no browser scenario cites", () => {
    expect(capturePlan([{ id: "S1", title: "pay", layer: "e2e", frame_ref: "12:34" }] as never, spec).uncited).toEqual(["12:40", "20:1"]);
  });
  it("keeps every scenario when the plan has no layers", () => {
    expect(keys(capturePlan([{ id: "S1", title: "pay", frame_ref: "20:1" }] as never, spec))).toEqual(["S1/1440x900-default"]);
  });
  it("captures only the states the file designs, and the default for a frame that lists none", () => {
    const s = { frames: [frame("1:1", [designed("default"), designed("error", null)]), frame("1:2", [])] } as never;
    const plan = capturePlan([{ id: "S1", title: "a", frame_ref: "1:1" }, { id: "S2", title: "b", frame_ref: "1:2" }] as never, s);
    expect(keys(plan)).toEqual(["S1/1440x900-default", "S2/1440x900-default"]);
  });
  it("turns a frame the spec does not have, or one with no viewport, into a note", () => {
    const s = { frames: [frame("1:1", [designed("default")], null)] } as never;
    const plan = capturePlan([{ id: "S1", title: "pay", layer: "e2e", frame_ref: "9:9" }, { id: "S2", title: "x", layer: "e2e", frame_ref: "1:1" }] as never, s);
    expect(plan.targets).toEqual([]);
    expect(plan.notes).toEqual([expect.stringContaining("S1 cites 9:9"), expect.stringContaining("S2 cites 1:1")]);
  });
  it("has nothing to capture without a spec or without a cited frame", () => {
    expect(capturePlan([{ id: "S1", title: "pay", layer: "e2e", frame_ref: "12:34" }] as never, null)).toEqual({ targets: [], uncited: [], notes: [] });
    expect(capturePlan([{ id: "S1", title: "pay", layer: "e2e" }] as never, spec).targets).toEqual([]);
  });
  it("stops at the cap and says how many it left out", () => {
    const many = { frames: Array.from({ length: 30 }, (_, i) => frame(`${i}:1`, [designed("default")])) } as never;
    const scenarios = Array.from({ length: 30 }, (_, i) => ({ id: `S${i}`, title: "s", layer: "e2e", frame_ref: `${i}:1` }));
    const plan = capturePlan(scenarios as never, many);
    expect(plan.targets).toHaveLength(MAX_CAPTURES);
    expect(plan.notes).toEqual([expect.stringContaining(`${30 - MAX_CAPTURES} captures over the cap`)]);
  });
});
