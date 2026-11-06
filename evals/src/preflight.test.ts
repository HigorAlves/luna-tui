import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { casesTable, preflight } from "./preflight.ts";

const WORTH = (PACKS.worth_learning.questions as Record<string, { instructions: string }>).worth!.instructions;
const stage = (n: string) => ({ schema: 3, stage: "worth_learning", pack: "worth_learning", attempt: 1, task: { id: n, title: n, description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null, ship: { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMin: 310 }, runs: 14 } } }, limits: { maxTurns: 1, timeoutMs: 1 }, env: { LUNA_FACTORY: "1" } });
const write = (dir: string, id: string, expectBody: unknown, n = id) => {
  mkdirSync(join(dir, "worth_learning", "cases", id), { recursive: true });
  writeFileSync(join(dir, "worth_learning", "cases", id, "stage.json"), JSON.stringify(stage(n)));
  writeFileSync(join(dir, "worth_learning", "cases", id, "expect.json"), JSON.stringify(expectBody));
};
const lab = (value: boolean, extra: Record<string, unknown> = {}) => ({ schema: 1, rubric: "r", checks: [{ kind: "equals", path: "worth.value", value }], kind: "labelled", label: { worth: { value } }, reading: { criteria: { worth: WORTH }, why: "w", second: { label: { worth: { value } }, agrees: true } }, ...extra });
const fakes = { imageExists: async () => true, check: async () => ({ available: true as const }), collector: async () => true };

describe("casesTable", () => {
  it("prints one row per case with its kind, label, the criterion quoted, the twin and the second reading", () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-"));
    write(dir, "a", lab(true));
    write(dir, "b", lab(true, { kind: "adversarial", twin: "a" }), "b2");
    const rows = casesTable(dir, "worth_learning").join("\n");
    expect(rows).toContain("a");
    expect(rows).toContain("adversarial");
    expect(rows).toContain("twin a");
    expect(rows).toContain(WORTH.slice(0, 20));
    expect(rows).toContain("second: worth.value=true agrees");
  });
});

describe("preflight", () => {
  it("fails a pack with fewer than eight cases, names what is missing, and exits 1; warns, never fails, for a collector that is down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-"));
    write(dir, "a", lab(true));
    const out = await preflight(dir, { ...fakes, collector: async () => false }, { packs: ["worth_learning"], engines: ["claude:haiku"] });
    expect(out.ok).toBe(false);
    const text = out.lines.join("\n");
    expect(text).toMatch(/fail.*worth_learning.*1 case/);
    expect(text).toMatch(/warn.*collector/);
    expect(text).toMatch(/ok.*claude:haiku/);
  });

  it("passes a pack with eight cases, six labelled, an adversarial with its twin and a borderline, every reading holding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-"));
    for (let i = 0; i < 5; i++) write(dir, `l${i}`, lab(i % 2 === 0));
    write(dir, "twin", lab(true));
    write(dir, "adv", lab(true, { kind: "adversarial", twin: "twin" }), "adv-steer");
    const reading = { criteria: {}, why: "w", second: { label: null, agrees: true }, readings: [{ label: { worth: { value: true } }, criteria: { worth: WORTH }, why: "leans a retro" }, { label: { worth: { value: false } }, criteria: { worth: WORTH }, why: "on plan" }] };
    write(dir, "border", { schema: 1, rubric: "r", checks: [{ kind: "between", path: "worth.p", min: 0.25, max: 0.75 }], kind: "borderline", reading });
    const out = await preflight(dir, fakes, { packs: ["worth_learning"], engines: ["claude:haiku"] });
    expect(out.lines.join("\n")).not.toMatch(/fail/);
    expect(out.ok).toBe(true);
  });

  it("fails a case whose reading does not hold, naming the case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-"));
    write(dir, "a", lab(true, { reading: { criteria: { worth: "stale" }, why: "w", second: { label: { worth: { value: true } }, agrees: true } } }));
    const out = await preflight(dir, fakes, { packs: ["worth_learning"], engines: [] });
    expect(out.lines.join("\n")).toMatch(/fail.*worth_learning\/a.*criterion text/);
  });

  it("fails when the image is missing or an engine's credential is not there, and never builds or calls anything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-"));
    const out = await preflight(dir, { ...fakes, imageExists: async () => false, check: async () => ({ available: false as const, reason: "no login" }) }, { packs: [], engines: ["codex:luna"] });
    expect(out.lines.join("\n")).toMatch(/fail.*image/);
    expect(out.lines.join("\n")).toMatch(/fail.*codex:luna.*no login/);
    expect(out.ok).toBe(false);
  });
});
