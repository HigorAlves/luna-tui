import { describe, expect, it } from "vitest";

import { settleParity } from "./design-parity.ts";

const desktop = { name: "1440x900", width: 1440, height: 900 };
const target = (state: "default" | "hover") => ({ scenario: "S1", frame: "12:34", viewport: desktop, state });
const plan = { targets: [target("default"), target("hover")], uncited: ["20:1"], notes: [] };
const designed = (state: string, nodeId: string) => ({ state, nodeId, suggestion: null });
const spec = { frames: [{ id: "12:34", name: "Checkout", viewport: { width: 1440, height: 900 }, states: [designed("default", "12:35"), designed("hover", "12:36")] }, { id: "20:1", name: "Settings", viewport: { width: 1440, height: 900 }, states: [designed("default", "20:2")] }] } as never;
const captures = [{ scenario: "S1", frame: "12:34", viewport: "1440x900", state: "default" as const, image: "/evidence/parity/S1/1440x900-default.png", styles: null, elements: 10 }];
const frame = (state: "default" | "hover", status: "compared" | "not_compared" = "compared") => ({ frame: "12:34", scenario: "S1", viewport: "1440x900", state, status, capture: `/evidence/parity/S1/1440x900-${state}.png`, render: "/design/1-0.png" });
const finding = (level: "blocker" | "should_fix" | "nit", confidence = 0.9, frameId = "12:34") => ({ level, kind: "token" as const, frame: frameId, node: "12:35", element: "button.pay", viewport: "1440x900", state: "default" as const, expected: "#1A73E8", actual: "#1B74E9", title: "Pay colour", why: "Off token.", confidence });
const answer = (over: Record<string, unknown> = {}) => ({ frames: [frame("default")], findings: [], designInput: "complete" as const, confidence: 0.9, summary: "ok", ...over });
const onlyDefault = { ...plan, targets: [target("default")] };
const settle = (a: unknown, bar = 0.75) => settleParity(a as never, { plan, spec, captures, bar });
const settleDefault = (a: unknown) => settleParity(a as never, { plan: onlyDefault, spec, captures, bar: 0.75 });

describe("settleParity", () => {
  it("never passes a frame with no capture: compared only where the machine has the capture", () => {
    const s = settle(answer({ frames: [frame("default"), frame("hover")] }));
    expect(s.frames.map((f) => [f.state, f.status, f.reason ?? null])).toEqual([["default", "compared", null], ["hover", "not_compared", "no capture"], ["default", "not_compared", "no scenario cites it"]]);
    expect(s.frames[0]).toMatchObject({ frame: "12:34", name: "Checkout", node: "12:35", scenario: "S1", viewport: "1440x900", render: "/design/1-0.png", pair: null, diff: null, diffRatio: null });
    expect(s.frames[2]).toMatchObject({ frame: "20:1", name: "Settings", scenario: null });
  });
  it("marks a planned frame the reviewer left out as not compared", () => {
    expect(settle(answer({ frames: [] })).frames[0]).toMatchObject({ status: "not_compared", reason: "the reviewer did not compare it" });
  });
  it("keeps a render path only when it is one of the machine's own", () => {
    expect(settle(answer({ frames: [{ ...frame("default"), render: "/etc/passwd" }] })).frames[0]!.render).toBeNull();
  });
  it("turns findings into design findings with a stable id, and drops one outside the plan", () => {
    const s = settle(answer({ findings: [finding("should_fix"), finding("blocker", 0.9, "99:9")] }));
    expect(s.findings).toEqual([expect.objectContaining({ path: "figma:12:34/12:35", line: 0, severity: "should_fix", category: "design", id: expect.stringMatching(/^D[0-9a-f]{8}$/), body: "Off token. Expected #1A73E8; built #1B74E9 (button.pay).", design: expect.objectContaining({ source: "parity", element: "button.pay", frame: "12:34", node: "12:35" }) })]);
    expect(s.notes).toEqual([expect.stringContaining("99:9")]);
  });
  it("a finding on the hover state, which has no capture, goes to the frame's one compared row with a note, not to a row nobody looked at", () => {
    const hover = { ...finding("blocker", 0.95), state: "hover" as const };
    const s = settle(answer({ frames: [frame("default"), frame("hover")], findings: [hover] }));
    expect(s.findings).toEqual([expect.objectContaining({ design: expect.objectContaining({ state: "default" }) })]);
    expect(s.notes).toEqual([expect.stringContaining("12:34")]);
  });
  it("takes a finding that names the viewport by a word, to the one compared row of its frame, and writes the row's own viewport and state", () => {
    const s = settleDefault(answer({ findings: [{ ...finding("blocker"), viewport: "desktop", state: "hover" }] }));
    expect(s.findings).toEqual([expect.objectContaining({ severity: "blocker", design: expect.objectContaining({ viewport: "1440x900", state: "default", node: "12:35" }) })]);
    expect(s.blockers).toBe(1);
  });
  it("gives a finding of the model's own words the same id as one in the plan's words, and a drifting node does not change it", () => {
    const plain = settleDefault(answer({ findings: [finding("should_fix")] })).findings[0]!.id;
    const worded = settleDefault(answer({ findings: [{ ...finding("should_fix"), viewport: "desktop", state: "focus", node: "made-up" }] })).findings[0]!.id;
    expect(worded).toBe(plain);
  });
  it("with several compared rows and no exact match, takes the row whose state matches, else the first, and says so", () => {
    const both = [frame("default"), frame("hover")];
    const taken = [...captures, { ...captures[0]!, state: "hover" as const, image: "/evidence/parity/S1/1440x900-hover.png" }];
    const run = (over: Record<string, unknown>) => settleParity(answer({ frames: both, findings: [{ ...finding("should_fix"), viewport: "desktop", ...over }] }) as never, { plan, spec, captures: taken, bar: 0.75 });
    const byState = run({ state: "hover" });
    expect(byState.findings[0]!.design).toMatchObject({ viewport: "1440x900", state: "hover", node: "12:36" });
    expect(byState.notes).toEqual([expect.stringContaining("12:34")]);
    const first = run({ state: "focus" });
    expect(first.findings[0]!.design).toMatchObject({ state: "default", node: "12:35" });
    expect(first.notes).toHaveLength(1);
    expect(run({ viewport: "1440x900", state: "hover" }).notes).toEqual([]);
  });
  it("drops a finding only when its frame has no compared row at all", () => {
    const s = settle(answer({ frames: [frame("default", "not_compared")], findings: [{ ...finding("blocker"), viewport: "desktop" }] }));
    expect(s.findings).toEqual([]);
    expect(s.notes).toEqual([expect.stringContaining("not compared")]);
  });
  it("gives the same id to the same difference in every round, whatever its title says", () => {
    const a = settle(answer({ findings: [finding("should_fix")] })).findings[0]!.id;
    const b = settle(answer({ findings: [{ ...finding("should_fix"), title: "Colour of pay is off" }] })).findings[0]!.id;
    expect(a).toBe(b);
  });
  it("lists the most severe findings first and keeps at most 40", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ ...finding("nit"), element: `li.row-${i}`, title: `Row ${i}` }));
    const s = settle(answer({ findings: [...many, { ...finding("blocker"), element: "li.last", title: "Last" }] }));
    expect(s.findings).toHaveLength(40);
    expect(s.findings[0]!.severity).toBe("blocker");
  });
  it.each([
    ["an open should_fix", answer({ findings: [finding("should_fix")] }), "open_findings"],
    ["an unsure blocker", answer({ findings: [finding("blocker", 0.6)] }), "open_findings"],
    ["confidence under the bar", answer({ confidence: 0.5 }), "low_confidence"],
    ["design input that was missing", answer({ designInput: "partial" }), "low_confidence"],
  ])("fires the gate for %s", (_why, a, reason) => {
    expect(settleDefault(a).gate).toMatchObject({ fires: true, why: expect.arrayContaining([reason]) });
  });
  it("fires the gate for a cited frame it could not compare, not for an uncited one", () => {
    expect(settleDefault(answer()).gate).toEqual({ fires: false, why: [] });
    expect(settle(answer()).gate).toEqual({ fires: true, why: ["not_compared"] });
  });
  it("lets a clean, confident review through with nits only", () => {
    const s = settleDefault(answer({ findings: [finding("nit")] }));
    expect(s.gate).toEqual({ fires: false, why: [] });
    expect(s.blockers).toBe(0);
  });
  it("counts the confident blockers, which go back to Build rather than to the gate", () => {
    const s = settleDefault(answer({ findings: [finding("blocker", 0.9)] }));
    expect(s.blockers).toBe(1);
    expect(s.gate.fires).toBe(false);
  });
  it("settles no answer as nothing compared and no confidence", () => {
    const s = settle(null);
    expect(s.frames.every((f) => f.status === "not_compared")).toBe(true);
    expect(s).toMatchObject({ confidence: 0, designInput: "missing", findings: [], gate: { fires: true, why: expect.arrayContaining(["low_confidence"]) } });
  });
});

describe("settleParity: a cited frame with no viewport", () => {
  const unviewed = { frames: [{ id: "30:1", name: "Modal", viewport: null, states: [designed("default", "30:2")] }] } as never;
  const noTargets = { targets: [], uncited: [], notes: [] };
  it("is not compared, with a reason, and fires the gate: never dropped, never a pass", () => {
    const s = settleParity(answer({ frames: [] }) as never, { plan: noTargets, spec: unviewed, captures: [], bar: 0.75, unplaced: [{ scenario: "S9", frame: "30:1" }] });
    expect(s.frames).toEqual([expect.objectContaining({ frame: "30:1", name: "Modal", node: "30:2", scenario: "S9", status: "not_compared", reason: "the spec gives this frame no viewport", capture: null, render: null })]);
    expect(s.gate).toEqual({ fires: true, why: ["not_compared"] });
  });
  it("is not made a pass by a reviewer that says it compared it", () => {
    const said = { frame: "30:1", scenario: "S9", viewport: "unknown", state: "default", status: "compared", capture: "/evidence/parity/S9/x.png", render: "/design/1-0.png" };
    const s = settleParity(answer({ frames: [said] }) as never, { plan: noTargets, spec: unviewed, captures: [], bar: 0.75, unplaced: [{ scenario: "S9", frame: "30:1" }] });
    expect(s.frames[0]).toMatchObject({ status: "not_compared", render: null });
  });
  it("sits beside the planned frames", () => {
    const s = settleParity(answer() as never, { plan: onlyDefault, spec, captures, bar: 0.75, unplaced: [{ scenario: "S2", frame: "20:1" }] });
    expect(s.frames.map((f) => [f.frame, f.scenario, f.status])).toEqual([["12:34", "S1", "compared"], ["20:1", "S2", "not_compared"], ["20:1", null, "not_compared"]]);
  });
});

describe("settleParity: targets over the capture cap", () => {
  it("are not compared, with the cap as the reason, and fire the gate", () => {
    const left = { scenario: "S9", frame: "12:34", viewport: "1440x900", state: "hover" as const, reason: "over the capture cap" };
    const s = settleParity(answer() as never, { plan: onlyDefault, spec, captures, bar: 0.75, unplaced: [left] });
    expect(s.frames.filter((f) => f.scenario === "S9")).toEqual([expect.objectContaining({ frame: "12:34", viewport: "1440x900", state: "hover", status: "not_compared", reason: "over the capture cap", capture: null })]);
    expect(s.gate.why).toContain("not_compared");
  });
});
