import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadCases } from "./cases.ts";
import { caseFromWaiver, harvestParity } from "./harvest-parity.ts";

const waiver = { kind: "not_a_difference", reason: "anti-aliasing", finding: { id: "D1", design: { frame: "F1", node: "12:34", kind: "token" }, severity: "should_fix" } };

describe("caseFromWaiver", () => {
  it("expects no finding on the waived node for a waiver that says it was no difference", () => {
    expect(caseFromWaiver(waiver as never).expect.checks).toContainEqual({ kind: "count", path: "findings[node=12:34]", max: 0 });
  });
  it("expects no blocker for an accepted difference, and keeps the reason in the rubric", () => {
    const c = caseFromWaiver({ ...waiver, kind: "accepted", reason: "brand allows it" } as never);
    expect(c.expect.checks).toContainEqual({ kind: "count", path: "findings[level=blocker]", max: 0 });
    expect(c.expect.rubric).toContain("brand allows it");
  });
  it("refuses a node that could climb out of the path grammar", () => {
    expect(() => caseFromWaiver({ ...waiver, finding: { ...waiver.finding, design: { ...waiver.finding.design, node: "a].b[" } } } as never)).toThrow(/node/);
  });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const canonical = (a: Record<string, string>) => `{${Object.keys(a).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(a[k])}`).join(",")}}`;
const sha = (a: Record<string, string>) => createHash("sha256").update(canonical(a)).digest("hex");

const stageOf = (extra: Record<string, unknown> = {}) => ({
  schema: 3, stage: "design_parity", pack: "design_parity", engine: "claude:sonnet", attempt: 1,
  task: { id: "t1", title: "Restyle checkout", description: "Follow the frame.", criteria: ["matches"], repoPath: "/Users/ana/dev/shop", branch: "task/t1", source: null },
  plan: null, decisions: [], bridge: [], priorFindings: [],
  context: {
    projectContext: null,
    design: { refs: [{ fileKey: "Qx7LmP2vR9sTa", nodeIds: ["12:34"], page: null, from: "issue" }] },
    parity: {
      plan: { targets: [{ scenario: "S1", frame: "12:34", viewport: { name: "1440x900", width: 1440, height: 900 }, state: "default" }, { scenario: "S2", frame: "99:1", viewport: { name: "1440x900", width: 1440, height: 900 }, state: "default" }], uncited: [], notes: [] },
      captures: [
        { scenario: "S1", frame: "12:34", viewport: "1440x900", state: "default", image: "/evidence/parity/S1/1440x900-default.png", styles: "/evidence/parity/S1/1440x900-default.styles.json", elements: 4 },
        { scenario: "S2", frame: "99:1", viewport: "1440x900", state: "default", image: "/evidence/parity/S2/1440x900-default.png", styles: "/evidence/parity/S2/1440x900-default.styles.json", elements: 2 },
      ],
      spec: { frames: [{ id: "12:34", name: "Checkout", viewport: { width: 1440, height: 900 }, states: [{ state: "default", nodeId: "12:34", suggestion: null }] }], tokens: { color: [], type: [], spacing: [], radius: [] }, components: [], a11yNotes: [], missing: [], confidence: 0.9 },
    },
  },
  limits: { maxTurns: 40, timeoutMs: 1 }, env: { LUNA_FACTORY: "1" },
  ...extra,
});

function world(over: { reason?: string; at?: string; stage?: object } = {}) {
  const state = mkdtempSync(join(tmpdir(), "hp-state-"));
  const out = mkdtempSync(join(tmpdir(), "hp-out-"));
  const sub = join(state, "runs", "run1-parity");
  mkdirSync(join(sub, "in"), { recursive: true });
  mkdirSync(join(sub, "design"), { recursive: true });
  writeFileSync(join(sub, "in", "stage.json"), JSON.stringify(over.stage ?? stageOf()));
  writeFileSync(join(sub, "design", "1-0.png"), PNG);
  const cap = join(state, "runs", "run1", "parity", "S1");
  mkdirSync(cap, { recursive: true });
  writeFileSync(join(cap, "1440x900-default.png"), PNG);
  writeFileSync(join(cap, "1440x900-default.styles.json"), JSON.stringify({ elements: [{ selector: "button.pay", radius: "4px" }] }));
  const truth = join(state, "ground-truth", "design_parity");
  mkdirSync(truth, { recursive: true });
  const body = { taskId: "t1", gate: "g1", kind: "not_a_difference", reason: over.reason ?? "anti-aliasing", at: over.at ?? "2026-11-10T10:00:00.000Z", parityRunId: "run1-parity",
    finding: { id: "D1", severity: "should_fix", design: { source: "parity", frame: "12:34", node: "12:40", element: "button.pay", kind: "token" } },
    frame: { frame: "12:34", scenario: "S1", viewport: "1440x900", state: "default", status: "compared", capture: join(cap, "1440x900-default.png"), render: join(sub, "design", "1-0.png") } };
  writeFileSync(join(truth, "t1-D1.json"), JSON.stringify(body));
  // A sign-off file beside the waivers is not a waiver.
  writeFileSync(join(truth, "t1-g1.json"), JSON.stringify({ taskId: "t1", gate: "g1", decision: "approved" }));
  return { state, out, truth, body };
}

describe("harvestParity", () => {
  it("writes a case with the sub-run's render as the replayed get_screenshot, the waived frame's capture mounted, and a stage that loads", () => {
    const w = world();
    const report = harvestParity({ stateDir: w.state, out: w.out });
    const id = `waiver-${createHash("sha256").update("t1D1").digest("hex").slice(0, 8)}`;
    expect(report).toEqual({ written: [id], kept: [], refused: [] });
    const dir = join(w.out, "design_parity", "cases", id);
    const png = join(dir, "mounts", "evidence", "parity", "S1", "1440x900-default.png");
    expect(readFileSync(png)).toEqual(PNG);
    expect(existsSync(join(dir, "mounts", "evidence", "parity", "S2"))).toBe(false);
    const shot = JSON.parse(readFileSync(join(dir, "mcp", "figma", "get_screenshot", `${sha({ fileKey: "Qx7LmP2vR9sTa", nodeId: "12:34" })}.json`), "utf8"));
    expect(shot).toMatchObject({ ok: true, images: [{ mime: "image/png", base64: PNG.toString("base64") }] });
    expect(existsSync(join(dir, "mcp", "figma", "tools.json"))).toBe(true);
    const [loaded] = loadCases(w.out, "design_parity");
    expect(loaded!.input).not.toHaveProperty("engine");
    expect(loaded!.input.task.repoPath).toBe("");
    // Only the waived frame stays in the plan and the captures.
    const parity = loaded!.input.context.parity!;
    expect(parity.plan.targets.map((t) => t.frame)).toEqual(["12:34"]);
    expect(parity.captures.map((c) => c.scenario)).toEqual(["S1"]);
    // The scrub took the person's home folder out of the stage.
    expect(readFileSync(join(dir, "stage.json"), "utf8")).not.toContain("/Users/ana");
    expect(loaded!.expect.checks).toContainEqual({ kind: "count", path: "findings[node=12:40]", max: 0 });
    expect(statSync(png).isFile()).toBe(true);
  });

  it("does not write a case twice, and reads only waivers since the date", () => {
    const w = world();
    harvestParity({ stateDir: w.state, out: w.out });
    expect(harvestParity({ stateDir: w.state, out: w.out }).kept).toHaveLength(1);
    const later = mkdtempSync(join(tmpdir(), "hp-out-"));
    expect(harvestParity({ stateDir: w.state, out: later, since: new Date("2026-12-01") })).toEqual({ written: [], kept: [], refused: [] });
  });

  it("refuses a bundle with a token-shaped reason, names it, and writes nothing", () => {
    const w = world({ reason: "see ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const report = harvestParity({ stateDir: w.state, out: w.out });
    expect(report.written).toEqual([]);
    expect(report.refused).toEqual([{ id: "t1-D1.json", reason: expect.stringMatching(/token-shaped/) }]);
    expect(existsSync(join(w.out, "design_parity"))).toBe(false);
  });

  it("refuses a waiver whose render is not a plain file in the sub-run's design folder", () => {
    const w = world();
    writeFileSync(join(w.truth, "t1-D1.json"), JSON.stringify({ ...w.body, frame: { ...w.body.frame, render: "/etc/passwd" } }));
    const report = harvestParity({ stateDir: w.state, out: w.out });
    expect(report.written).toEqual([]);
    expect(report.refused[0]).toMatchObject({ id: "t1-D1.json", reason: expect.stringMatching(/render/) });
  });
});
