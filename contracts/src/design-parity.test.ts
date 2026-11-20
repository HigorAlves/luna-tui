// Design parity (RFC 0013, phase 3): captures, the reviewer's answer and the design report.
import { describe, expect, it } from "vitest";

import { DesignConfig } from "./config-v22.ts";
import { CaptureTarget, DesignParityAnswer, captureKey, parityBarOf, parityFindingId } from "./design-parity.ts";
import { VerifyDesignReport } from "./design-report.ts";
import { Finding } from "./stage.ts";

const desktop = { name: "desktop", width: 1440, height: 900 };

describe("CaptureTarget", () => {
  it("takes a scenario, a spec frame, a named viewport and a state, and names its file", () => {
    expect(captureKey(CaptureTarget.parse({ scenario: "S1", frame: "F1", viewport: desktop, state: "hover" }))).toBe("S1/desktop-hover");
  });
  it("refuses a viewport name a path could not carry and a state outside the spec's", () => {
    expect(CaptureTarget.safeParse({ scenario: "S1", frame: "F1", viewport: { ...desktop, name: "../x" }, state: "default" }).success).toBe(false);
    expect(CaptureTarget.safeParse({ scenario: "S1", frame: "F1", viewport: desktop, state: "pressed" }).success).toBe(false);
  });
});

describe("DesignParityAnswer", () => {
  const answer = {
    frames: [{ frame: "F1", scenario: "S1", viewport: "desktop", state: "default", status: "compared", capture: "/evidence/parity/S1/desktop-default.png", render: "/design/1-0.png" }],
    findings: [{ level: "should_fix", kind: "token", frame: "F1", node: "12:34", element: "button.pay", viewport: "desktop", state: "default", expected: "#1A73E8 (color/primary)", actual: "#1B74E9", title: "Pay button is off the primary token", why: "A hex near the token, not the token.", confidence: 0.9 }],
    designInput: "complete",
    confidence: 0.85,
    summary: "One token drift.",
  };
  it("parses a reviewer's answer", () => {
    expect(DesignParityAnswer.parse(answer).findings[0]!.node).toBe("12:34");
  });
  it("has no pass for a frame: it was compared, or it was not", () => {
    expect(DesignParityAnswer.safeParse({ ...answer, frames: [{ ...answer.frames[0], status: "pass" }] }).success).toBe(false);
  });
  it("is not a list of review Findings: the factory must leave them in the answer", () => {
    expect(Finding.safeParse(answer.findings[0]).success).toBe(false);
  });
});

describe("parityFindingId", () => {
  const at = { frame: "F1", node: "12:34", kind: "token" as const, viewport: "desktop", state: "default" as const };
  it("is the same in every round for the same place and kind, whatever the title says", () => {
    expect(parityFindingId(at)).toMatch(/^D[0-9a-f]{8}$/);
    expect(parityFindingId({ ...at })).toBe(parityFindingId(at));
    expect(parityFindingId({ ...at, kind: "layout" })).not.toBe(parityFindingId(at));
    expect(parityFindingId({ ...at, state: "hover" })).not.toBe(parityFindingId(at));
    expect(parityFindingId({ ...at, viewport: "mobile" })).not.toBe(parityFindingId(at));
    expect(parityFindingId({ ...at, node: "12:35" })).not.toBe(parityFindingId(at));
  });
  it("does not run two fields together", () => {
    expect(parityFindingId({ ...at, frame: "F1", node: "2:3" })).not.toBe(parityFindingId({ ...at, frame: "F12", node: ":3" }));
  });
});

describe("Finding.design", () => {
  it("names the frame, the node and the build element, and can be waived", () => {
    const f = Finding.parse({ path: "figma:F1/12:34", line: 0, severity: "should_fix", title: "t", body: "b", confidence: 0.9, category: "design", design: { source: "parity", frame: "F1", node: "12:34", element: "button.pay", viewport: "desktop", state: "default", kind: "token", expected: "#1A73E8", actual: "#1B74E9" }, resolution: { status: "waived", by: "person" } });
    expect(f.design?.element).toBe("button.pay");
    expect(f.resolution?.status).toBe("waived");
  });
  it("still parses a finding from before", () => {
    expect(Finding.safeParse({ path: "a.ts", line: 3, severity: "bug", title: "t", body: "b", confidence: 0.9 }).success).toBe(true);
  });
});

describe("design.parity", () => {
  it("takes a bar between 0 and 1 and a publish rule, with defaults", () => {
    expect(DesignConfig.safeParse({ parity: { bar: 0.8, publish: "never" } }).success).toBe(true);
    expect(DesignConfig.safeParse({ parity: { bar: 1.5 } }).success).toBe(false);
    expect(DesignConfig.safeParse({ parity: { publish: "sometimes" } }).success).toBe(false);
    expect(parityBarOf(undefined)).toBe(0.75);
    expect(parityBarOf("off")).toBe(0.75);
    expect(parityBarOf({ parity: { bar: 0.6 } })).toBe(0.6);
  });
});

describe("VerifyDesignReport", () => {
  it("says whether the gate fires and why", () => {
    const r = VerifyDesignReport.parse({ wcag: "AA", a11y: null, parity: null, findings: [], gate: { fires: true, why: ["low_confidence"] } });
    expect(r.gate.why).toEqual(["low_confidence"]);
  });
});
