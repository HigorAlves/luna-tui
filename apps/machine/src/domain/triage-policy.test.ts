import { FACTORY_DEFAULTS, type TaskClassification } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { askedQuestions, triageVerdicts } from "./triage-policy.ts";

const config = FACTORY_DEFAULTS.triage;
const sub = (c: number) => ({ answer: 1, confidence: c });
const classification = (over: Partial<TaskClassification> = {}, signals: NonNullable<TaskClassification["signals"]> = {}): TaskClassification => ({
  kind: "bug", kindConfidence: 0.9, ready: true, size: 1, sizeBucket: "S", typeOfWork: "backend", priority: "P2", riskPrelim: "low", archive: false, archiveReason: "none", confidence: 0.9, at: "", model: "m",
  signals: { kind: { answer: "bug", confidence: 0.9 }, size: { answer: "S", confidence: 0.8 }, who: sub(0.9), what: sub(0.9), impact: sub(0.9), time: sub(0.9), demand: sub(0.9), risk_prelim: { answer: "low", confidence: 0.9 }, archive: { answer: false, confidence: 0.95 }, ...signals },
  ...over,
});

describe("triageVerdicts", () => {
  it("proceeds when every field is at or above its bar", () => {
    const v = triageVerdicts(classification(), config);
    expect(Object.values(v).map((f) => f.verdict)).toEqual(["proceed", "proceed", "proceed", "proceed", "proceed"]);
    expect(Object.keys(v)).toEqual(["kind", "size", "urgency", "risk", "archive"]);
  });

  it("flags in the band of 0.15 under the bar and asks below it, at each field's own bar (kind 0.80, size 0.60, urgency 0.70, risk 0.85, archive 0.90)", () => {
    const at = (signals: NonNullable<TaskClassification["signals"]>) => triageVerdicts(classification({}, signals), config);
    expect(at({ kind: { answer: "bug", confidence: 0.8 } }).kind.verdict).toBe("proceed");
    expect(at({ kind: { answer: "bug", confidence: 0.79 } }).kind.verdict).toBe("flag");
    expect(at({ kind: { answer: "bug", confidence: 0.65 } }).kind.verdict).toBe("flag");
    expect(at({ kind: { answer: "bug", confidence: 0.64 } }).kind.verdict).toBe("ask");
    expect(at({ size: { answer: "S", confidence: 0.6 } }).size.verdict).toBe("proceed");
    expect(at({ size: { answer: "S", confidence: 0.44 } }).size.verdict).toBe("ask");
    expect(at({ risk_prelim: { answer: "low", confidence: 0.84 } }).risk.verdict).toBe("flag");
    expect(at({ risk_prelim: { answer: "low", confidence: 0.69 } }).risk.verdict).toBe("ask");
    expect(at({ archive: { answer: true, confidence: 0.89 } }).archive.verdict).toBe("flag");
  });

  it("reads urgency by the lowest of its five sub-scores' confidences", () => {
    const v = triageVerdicts(classification({}, { time: sub(0.5) }), config);
    expect(v.urgency).toMatchObject({ verdict: "ask", confidence: 0.5 });
    expect(triageVerdicts(classification({}, { demand: sub(0.6) }), config).urgency).toMatchObject({ verdict: "flag", confidence: 0.6 });
  });

  it("names the model's guess for each field", () => {
    const v = triageVerdicts(classification(), config);
    expect(v.kind.guess).toBe("bug");
    expect(v.size.guess).toBe("S");
    expect(v.urgency.guess).toBe("P2");
    expect(v.risk.guess).toBe("low");
    expect(v.archive.guess).toBe("no");
  });

  it("lets a repo's bar for a question win over the config, per question", () => {
    const sig = { kind: { answer: "bug", confidence: 0.7 } };
    expect(triageVerdicts(classification({}, sig), config).kind.verdict).toBe("flag");
    expect(triageVerdicts(classification({}, sig), config, { overrides: { kind: { proceed: 0.6 } } }).kind.verdict).toBe("proceed");
    expect(triageVerdicts(classification({}, sig), config, { overrides: { kind: { proceed: 0.95, flag: 0.9 } } }).kind.verdict).toBe("ask");
    // an urgency sub-score's override moves that sub-score only
    expect(triageVerdicts(classification({}, { who: sub(0.5) }), config, { overrides: { who: { proceed: 0.4 } } }).urgency.verdict).toBe("proceed");
  });

  it("raises a field's confidence by half the gap to 1 when a hint agrees and halves it when one disagrees", () => {
    const base = classification({}, { kind: { answer: "bug", confidence: 0.6 }, size: { answer: "S", confidence: 0.6 } });
    const agree = triageVerdicts(base, config, { hints: { kind: "bug", size: "m" } });
    expect(agree.kind.confidence).toBeCloseTo(0.8, 10); // 0.6 + (1 - 0.6) / 2
    expect(agree.kind.verdict).toBe("proceed");
    expect(agree.size.confidence).toBeCloseTo(0.3, 10); // disagrees: 0.6 / 2
    expect(agree.size.verdict).toBe("ask");
    expect(triageVerdicts(base, config, { hints: {} }).kind.confidence).toBe(0.6);
  });

  it("never weighs a hint above 0.5, whatever the config says", () => {
    const base = classification({}, { kind: { answer: "bug", confidence: 0.6 } });
    expect(triageVerdicts(base, { ...config, hint_weight: 1 }, { hints: { kind: "bug" } }).kind.confidence).toBeCloseTo(0.8, 10);
  });
});

describe("askedQuestions", () => {
  it("makes one question per field at ask, with the guess and its confidence, and the guess as the recommended answer", () => {
    const v = triageVerdicts(classification({}, { kind: { answer: "bug", confidence: 0.62 }, risk_prelim: { answer: "low", confidence: 0.4 } }), config);
    expect(askedQuestions(v)).toEqual([
      { field: "kind", guess: "bug", confidence: 0.62, question: "Is this a bug or a feature? The model read it as a bug, 0.62", recommended: "bug" },
      { field: "risk", guess: "low", confidence: 0.4, question: "How risky is the change: low, medium or high? The model read it as low, 0.40", recommended: "low" },
    ]);
  });
  it("is empty when nothing is at ask", () => {
    expect(askedQuestions(triageVerdicts(classification({}, { size: { answer: "S", confidence: 0.5 } }), config))).toEqual([]);
  });
});
