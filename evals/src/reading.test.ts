import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { Expect } from "./expect.ts";
import { type CaseView, checkReading, criterionOf } from "./reading.ts";

const WORTH = (PACKS.worth_learning.questions as Record<string, { instructions: string }>).worth!.instructions;
const view = (id: string, over: Partial<Expect> = {}, stage: unknown = { n: id }): CaseView => ({ id, stage, expect: { schema: 1, checks: [], rubric: "r", ...over } as Expect });
const labelled = (id: string, over: Partial<Expect> = {}, stage: unknown = { n: id }): CaseView =>
  view(id, { kind: "labelled", label: { worth: { value: true } }, reading: { criteria: { worth: WORTH }, why: "five times the plan, so a retro teaches", second: { label: { worth: { value: true } }, agrees: true } }, ...over }, stage);
const problems = (c: CaseView, others: CaseView[] = []) => checkReading("worth_learning", c.id, c.expect, c.stage, others);

describe("checkReading", () => {
  it("passes a labelled case whose reading quotes the question's own instructions", () => {
    expect(problems(labelled("a"))).toEqual([]);
  });

  it("asks a case with a label for a kind and a reading", () => {
    expect(problems(view("a", { label: { worth: { value: true } } }))).toEqual(expect.arrayContaining([expect.stringContaining("kind")]));
    expect(problems(labelled("a", { reading: undefined }))).toEqual(expect.arrayContaining([expect.stringContaining("reading")]));
  });

  it("ties the reading to the criterion character for character, so a changed criterion breaks it", () => {
    const stale = labelled("a", { reading: { criteria: { worth: `${WORTH} (old)` }, why: "w", second: { label: { worth: { value: true } }, agrees: true } } });
    expect(problems(stale)).toEqual(expect.arrayContaining([expect.stringContaining("criterion text")]));
  });

  it("refuses a question the pack does not ask and a value that is not one of its labels", () => {
    expect(problems(labelled("a", { label: { nope: { value: true } } })).join("\n")).toContain("nope");
    expect(problems(labelled("a", { label: { worth: { value: "yes" } } })).join("\n")).toContain("worth");
  });

  it("wants a second reading that is the label and agrees", () => {
    expect(problems(labelled("a", { reading: { criteria: { worth: WORTH }, why: "w", second: { label: { worth: { value: false } }, agrees: false } } })).join("\n")).toContain("second reading");
  });

  it("ties a choice to its criterion and names a reason for every other label when the question has six or fewer", () => {
    const risk = PACKS.risk_score.questions as Record<string, { criteria: Record<string, string> }>;
    const base = { kind: "labelled" as const, label: { complexity: { choice: "S" } } };
    const reading = (ruledOut?: Array<{ question: string; label: string; why: string }>) => ({ criteria: { complexity: risk.complexity!.criteria.S! }, why: "w", ...(ruledOut ? { ruledOut } : {}), second: { label: { complexity: { choice: "S" } }, agrees: true } });
    const out = (r: ReturnType<typeof reading>) => checkReading("risk_score", "a", { schema: 1, checks: [], rubric: "r", ...base, reading: r } as Expect, {}, []);
    expect(out(reading()).join("\n")).toContain("ruled out");
    const all = ["M", "L", "XL"].map((l) => ({ question: "complexity", label: l, why: "this reaches further than a few lines in one place" }));
    expect(out(reading(all))).toEqual([]);
    expect(out(reading(all.map((r, i) => (i === 0 ? { ...r, why: "short" } : r)))).join("\n")).toContain("ruled out");
  });

  it("ties a score to the rubric text of its level", () => {
    const rubric = (PACKS.risk_score.questions as Record<string, { rubric: Record<string, string> }>).blast_radius!.rubric;
    const ok = { schema: 1, checks: [], rubric: "r", kind: "labelled", label: { blast_radius: { score: 2 } }, reading: { criteria: { blast_radius: rubric.wide! }, why: "w", second: { label: { blast_radius: { score: 2 } }, agrees: true } } } as Expect;
    expect(checkReading("risk_score", "a", ok, {}, [])).toEqual([]);
    expect(checkReading("risk_score", "a", { ...ok, reading: { ...ok.reading!, criteria: { blast_radius: rubric.one! } } } as Expect, {}, []).join("\n")).toContain("criterion text");
  });

  it("wants an adversarial case to name a twin that is labelled, has the same label and a different input", () => {
    const twin = labelled("twin");
    const adv = (id: string, over: Partial<Expect> = {}, stage: unknown = { n: id, steer: true }) => labelled(id, { kind: "adversarial", twin: "twin", ...over }, stage);
    expect(problems(adv("adv"), [twin])).toEqual([]);
    expect(problems(adv("adv", { twin: undefined }), [twin]).join("\n")).toContain("twin");
    expect(problems(adv("adv", { twin: "ghost" }), [twin]).join("\n")).toContain("ghost");
    expect(problems(adv("adv"), [labelled("twin", { label: { worth: { value: false } } })]).join("\n")).toContain("label");
    expect(problems(adv("adv", {}, { n: "twin" }), [twin]).join("\n")).toContain("differ");
    expect(problems(adv("adv"), [labelled("twin", { kind: "adversarial" })]).join("\n")).toContain("labelled");
  });

  it("wants a borderline case to have no label, two readings with different labels tied to the criterion, and a bounded confidence", () => {
    const reading = { criteria: {}, why: "w", second: { label: null, agrees: true }, readings: [
      { label: { worth: { value: true } }, criteria: { worth: WORTH }, why: "a mild surprise leans to a retro" },
      { label: { worth: { value: false } }, criteria: { worth: WORTH }, why: "the plan held, so nothing to learn" },
    ] };
    const border = (over: Partial<Expect> = {}) => view("b", { kind: "borderline", reading, checks: [{ kind: "between", path: "worth.p", min: 0.25, max: 0.75 }], ...over });
    expect(problems(border())).toEqual([]);
    expect(problems(border({ label: { worth: { value: true } } })).join("\n")).toContain("no label");
    expect(problems(border({ reading: { ...reading, readings: [reading.readings[0]!] } })).join("\n")).toContain("two readings");
    expect(problems(border({ reading: { ...reading, readings: [reading.readings[0]!, { ...reading.readings[0]!, why: "same label again" }] } })).join("\n")).toContain("different");
    expect(problems(border({ checks: [] })).join("\n")).toContain("confidence");
    expect(problems(border({ checks: [{ kind: "between", path: "worth.p", min: 0.1, max: 0.95 }] })).join("\n")).toContain("confidence");
  });

  it("wants a case with no label to be a borderline one", () => {
    expect(problems(view("a")).join("\n")).toContain("borderline");
  });

  it("counts the questions an answer pack's labelled case labels", () => {
    const some = { schema: 1, checks: [], rubric: "r", kind: "labelled", label: { race: { choice: "none" } }, reading: { criteria: {}, why: "w", second: { label: { race: { choice: "none" } }, agrees: true } } } as unknown as Expect;
    expect(checkReading("triage_signals", "a", some, {}, []).join("\n")).toContain("at least 8");
  });
});

describe("criterionOf", () => {
  it("gives the pack's own text for a choice label, a yes/no and a score level", () => {
    expect(criterionOf("worth_learning", "worth", { value: true })).toBe(WORTH);
    expect(criterionOf("risk_score", "blast_radius", { score: 0 })).toBe((PACKS.risk_score.questions as Record<string, { rubric: Record<string, string> }>).blast_radius!.rubric.one);
    expect(criterionOf("worth_learning", "nope", { value: true })).toBeNull();
    expect(criterionOf("worth_learning", "worth", { value: "x" })).toBeNull();
  });
});
