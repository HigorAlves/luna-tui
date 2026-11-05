import type { TaskClassification } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { composeRecord, recordComplete } from "./triage-record.ts";

const classification: TaskClassification = {
  kind: "bug", ready: true, size: 1, sizeBucket: "S", typeOfWork: "backend", priority: "P1", riskPrelim: "medium", archive: false, archiveReason: "none", confidence: 0.8, at: "", model: "m",
  subScores: { who: 3, what: 2, impact: 2, time: 1, demand: 1 }, signals: { kind: { answer: "bug", confidence: 0.9 } },
};
const base = {
  draft: { goal: "Stop the export crashing", reason: "one function, tests exist" }, summary: "The export crashes on large carts.", classification, source: "github", decision: "plan" as const,
  qa: [{ question: "Which OS?", answer: "macOS" }], goalRef: "none", model: "claude-opus", at: "2026-11-05T00:00:00.000Z",
};

describe("composeRecord", () => {
  it("fills every fact from the machine's own reading and marks the machine as the decider, at version 1", () => {
    const record = composeRecord(base);
    expect(record).toEqual({
      source: "github", goal: "Stop the export crashing", reason: "one function, tests exist", decision: "plan", signals: { kind: { answer: "bug", confidence: 0.9 } },
      qa: [{ question: "Which OS?", answer: "macOS" }], at: "2026-11-05T00:00:00.000Z", model: "claude-opus", summary: "The export crashes on large carts.",
      kind: "bug", typeOfWork: "backend", size: "S", urgency: "P1", risk: "medium", urgencyDetail: { priority: "P1", subScores: { who: 3, what: 2, impact: 2, time: 1, demand: 1 } },
      riskPrelim: "medium", goalRef: "none", hintsUsed: [], decisionBy: "machine", version: 1,
    });
    expect(recordComplete(record)).toEqual({ complete: true, missing: [] });
  });

  it("raises the version by one on every re-triage, counting an old record with no version as 1", () => {
    expect(composeRecord({ ...base, previous: { version: 3 } }).version).toBe(4);
    expect(composeRecord({ ...base, previous: {} }).version).toBe(2);
  });

  it("prefers the draft's own summary and leaves out what the machine could not fill", () => {
    const record = composeRecord({ ...base, draft: { ...base.draft, summary: "Draft summary" }, classification: null });
    expect(record.summary).toBe("Draft summary");
    expect(record).not.toHaveProperty("kind");
    expect(record).not.toHaveProperty("urgencyDetail");
  });
});

describe("recordComplete", () => {
  it("names what is missing", () => {
    const { complete, missing } = recordComplete(composeRecord({ ...base, classification: null, summary: "" }));
    expect(complete).toBe(false);
    expect(missing).toEqual(["kind", "type of work", "size", "urgency", "preliminary risk", "summary"]);
    expect(recordComplete(null)).toEqual({ complete: false, missing: ["the whole record"] });
  });

  it("wants a goal sentence and a summary of at most 120 words", () => {
    expect(recordComplete(composeRecord({ ...base, draft: { goal: "  ", reason: "r" } })).missing).toEqual(["goal (a sentence, or `none`)"]);
    const long = Array.from({ length: 121 }, () => "word").join(" ");
    expect(recordComplete(composeRecord({ ...base, summary: long })).missing).toEqual(["a summary of at most 120 words (this one has 121)"]);
    expect(recordComplete(composeRecord({ ...base, summary: long.split(" ").slice(0, 120).join(" ") })).complete).toBe(true);
    expect(recordComplete(composeRecord({ ...base, draft: { goal: "none", reason: "r" } })).complete).toBe(true);
  });
});
