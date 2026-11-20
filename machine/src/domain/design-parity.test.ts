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
  it("gives the same id to the same difference in every round, whatever its title says", () => {
    const a = settle(answer({ findings: [finding("should_fix")] })).findings[0]!.id;
    const b = settle(answer({ findings: [{ ...finding("should_fix"), title: "Colour of pay is off" }] })).findings[0]!.id;
    expect(a).toBe(b);
  });
  it("lists the most severe findings first and keeps at most 40", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ ...finding("nit"), node: `1:${i}` }));
    const s = settle(answer({ findings: [...many, { ...finding("blocker"), node: "7:7" }] }));
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
