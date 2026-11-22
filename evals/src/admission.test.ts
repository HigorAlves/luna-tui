import { AGENT_PACKS, type EngineId } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { admission, admissionPath, admit, cardOf, unadmitted } from "./admission.ts";

const card = (n: number, passRate: number, extra: Record<string, number> = {}) => ({ n, passRate, ...extra });

describe("admit", () => {
  it("admits an engine within two points of the baseline on eight cases", () => {
    expect(admit(card(8, 0.86), card(8, 0.875))).toEqual({ pass: true, reasons: [] });
  });
  it("refuses one further behind, naming the gap", () => {
    expect(admit(card(10, 0.7), card(10, 0.8))).toEqual({ pass: false, reasons: ["pass rate 70% is more than 2 points under 80%"] });
  });
  it("refuses too few cases", () => {
    expect(admit(card(6, 1), card(6, 1))).toMatchObject({ pass: false, reasons: ["the baseline has n 6, 8 are needed"] });
  });
  it("holds recall and false blockers to the baseline when both cards have them", () => {
    expect(admit(card(8, 0.9, { recall: 0.7, falseBlockerRate: 0.2 }), card(8, 0.9, { recall: 0.8, falseBlockerRate: 0.1 })).reasons).toEqual(["recall 70% is more than 2 points under 80%", "false blockers 20% are more than 2 points over 10%"]);
  });
  it("skips recall and false blockers when only the candidate has them", () => {
    expect(admit(card(8, 0.9, { recall: 0.1 }), card(8, 0.9)).pass).toBe(true);
  });
  it("admits an exact two-point gap (9/50 against 2/10) on every comparison", () => {
    expect(admit(card(50, 9 / 50), card(50, 2 / 10)).pass).toBe(true);
    expect(admit(card(50, 0.9, { recall: 9 / 50 }), card(50, 0.9, { recall: 2 / 10 })).pass).toBe(true);
    expect(admit(card(50, 0.9, { falseBlockerRate: 2 / 10 }), card(50, 0.9, { falseBlockerRate: 9 / 50 })).pass).toBe(true);
  });
  it("cannot compare when the baseline has a metric the candidate lacks", () => {
    const recall = admit(card(8, 0.9), card(8, 0.9, { recall: 0.8 }));
    expect(recall).toMatchObject({ pass: false, incomparable: true });
    expect(recall.reasons).toEqual(["the baseline records recall and the candidate does not"]);
    expect(admit(card(8, 0.9), card(8, 0.9, { falseBlockerRate: 0.1 })).reasons).toEqual(["the baseline records the false-blocker rate and the candidate does not"]);
  });
  it("cannot compare against a baseline under eight cases, or of another size", () => {
    expect(admit(card(10, 1), card(6, 1))).toMatchObject({ pass: false, incomparable: true, reasons: ["the baseline has n 6, 8 are needed"] });
    expect(admit(card(10, 1), card(9, 1))).toMatchObject({ pass: false, incomparable: true, reasons: ["the candidate has n 10 and the baseline n 9: they must run the same cases"] });
  });
  it("cannot compare when both record case ids and they differ", () => {
    expect(admit({ ...card(8, 1), ids: ["a", "b"] }, { ...card(8, 1), ids: ["a", "c"] })).toMatchObject({ pass: false, incomparable: true, reasons: ["the two baselines ran different cases: b, c"] });
    expect(admit({ ...card(8, 1), ids: ["b", "a"] }, { ...card(8, 1), ids: ["a", "b"] }).pass).toBe(true);
    expect(admit({ ...card(8, 1), ids: ["a"] }, card(8, 1)).pass).toBe(true);
  });
});

describe("cardOf", () => {
  it("reads a saved baseline's summary", () => {
    expect(cardOf({ summary: { cases: 9, passRate: 0.75 } })).toEqual({ n: 9, passRate: 0.75 });
    expect(cardOf({ summary: { cases: 9, passRate: 0.75, recall: 0.5, falseBlockerRate: 0.1 } })).toEqual({ n: 9, passRate: 0.75, recall: 0.5, falseBlockerRate: 0.1 });
  });
  it("records the case ids once each, when the baseline lists its cases", () => {
    expect(cardOf({ summary: { cases: 2, passRate: 1 }, cases: [{ id: "b" }, { id: "a" }, { id: "a" }] })).toEqual({ n: 2, passRate: 1, ids: ["a", "b"] });
  });
});

describe("admissionPath", () => {
  it("sits beside the engine's baselines", () => {
    expect(admissionPath("/e", "codex:sol", "design_parity")).toBe("/e/baselines/codex-sol/design_parity.admission.json");
  });
});

describe("admission", () => {
  const dir = mkdtempSync(join(tmpdir(), "admission-cli-"));
  const save = (slug: string, cases: number, passRate: number) => {
    mkdirSync(join(dir, "baselines", slug), { recursive: true });
    writeFileSync(join(dir, "baselines", slug, "design_parity.json"), JSON.stringify({ summary: { cases, passRate } }));
  };
  const ask = { pack: "design_parity" as const, engine: "codex:sol" as const, against: "claude:opus" as const, at: "2026-01-01T00:00:00.000Z" };

  it("exits 2 when a baseline is missing, naming it", () => {
    save("claude-opus", 10, 0.9);
    const out = admission(dir, ask);
    expect(out.code).toBe(2);
    expect(out.lines[0]).toContain("codex-sol/design_parity.json");
  });
  it("refuses an --against that is not Claude", () => {
    expect(admission(dir, { ...ask, against: "codex:luna" }).code).toBe(2);
  });
  it("exits 2 and says why when the baselines cannot be compared", () => {
    save("claude-opus", 10, 0.9);
    save("codex-sol", 9, 0.9);
    expect(admission(dir, ask)).toMatchObject({ code: 2, lines: ["cannot compare codex:sol on design_parity: the candidate has n 9 and the baseline n 10: they must run the same cases"] });
  });
  it("exits 1 with each reason, and 0 on a pass, with the record to write", () => {
    save("codex-sol", 10, 0.7);
    expect(admission(dir, ask)).toMatchObject({ code: 1, lines: ["refused: codex:sol on design_parity: pass rate 70% is more than 2 points under 90% (decided on pass rate alone, no recall or false-blocker rate in both baselines)"], record: { pass: false } });
    save("codex-sol", 10, 0.9);
    expect(admission(dir, ask)).toEqual({ code: 0, lines: ["admitted: codex:sol on design_parity (n 10, pass 90% against claude:opus 90%; decided on pass rate alone, no recall or false-blocker rate in both baselines)"], record: { ...ask, pass: true, reasons: [], candidate: { n: 10, passRate: 0.9 }, baseline: { n: 10, passRate: 0.9 } } });
  });
});

describe("unadmitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "admission-"));
  const pack = { id: "design_parity" as const, engines: { allowed: ["claude:opus", "codex:sol"] as EngineId[] } };
  const write = (record: object) => {
    const file = admissionPath(dir, "codex:sol", "design_parity");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  };

  it("names a non-Claude engine with no record", () => {
    expect(unadmitted(pack, dir)).toEqual([`design_parity allows codex:sol with no ${admissionPath(dir, "codex:sol", "design_parity")}`]);
  });
  it("refuses a record that failed, or is against another family", () => {
    write({ pack: "design_parity", engine: "codex:sol", against: "claude:opus", pass: false });
    expect(unadmitted(pack, dir)).toHaveLength(1);
    write({ pack: "design_parity", engine: "codex:sol", against: "codex:luna", pass: true });
    expect(unadmitted(pack, dir)).toHaveLength(1);
  });
  it("accepts a passing record against Claude, and a pack of Claude engines alone", () => {
    write({ pack: "design_parity", engine: "codex:sol", against: "claude:opus", pass: true });
    expect(unadmitted(pack, dir)).toEqual([]);
    expect(unadmitted({ ...pack, engines: { allowed: ["claude:opus"] } }, "/nowhere")).toEqual([]);
  });
});

describe("a pack that reads images", () => {
  const evals = join(dirname(fileURLToPath(import.meta.url)), "..");
  it.each(AGENT_PACKS.filter((p) => p.vision).map((p) => [p.id, p] as const))("%s allows another family only after it passed its eval against Claude", (_id, pack) => {
    expect(unadmitted(pack, evals)).toEqual([]);
  });
});
