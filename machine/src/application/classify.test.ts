// Intake's classifier: triage_signals through PackRuns, recorded as intake's; no Jev credential
// and every failure answer null, the first silently, the rest with a line.
import type { RunInput, RunResult } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { confidentQuestion, createIssueClassifier } from "./classify.ts";
import { type PackRunsPort, QueueFullError, RunFailedError, RunNoCredentialError, RunOverBudgetError } from "./pack-runs.ts";

const issue = { title: "Which Postgres do we support?", description: "Is 14 fine?", labels: ["question"], source: "jira:HAR-7" };
const answer = { kind: { choice: "question", confidence: 0.98 }, area: { choice: "machine", confidence: 0.9 }, ready: { value: false, p: 0.1 }, size: { score: 0.2, confidence: 0.85 }, urgency: { score: 1, confidence: 0.8 }, risk: { score: 0.2, confidence: 0.9 }, archive: { value: false, p: 0.02 }, archive_reason: { choice: "none", confidence: 0.95 } };
const NOW = new Date("2026-11-03T12:00:00Z");

function runs(result: RunResult | Error) {
  const calls: Array<{ input: RunInput; client: string | null }> = [];
  const port: PackRunsPort = {
    run: async (input, client) => {
      calls.push({ input, client });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { port, calls };
}

describe("the intake classifier", () => {
  it("runs triage_signals with the issue, as intake, on the pack's own engine choice, and keeps the picks, the lowest confidence, when and the model", async () => {
    const { port, calls } = runs({ answer, usage: { model: "typesafe-ai/jev", engine: "jev", turns: 1, durationMs: 500, costUsd: 0.00003 } });
    const lines: string[] = [];
    const c = await createIssueClassifier({ runs: port, now: () => NOW, log: (l) => lines.push(l) }).classify(issue);
    expect(calls).toEqual([{ input: { pack: "triage_signals", context: { issue } }, client: "intake" }]);
    expect(c).toMatchObject({ kind: "question", kindConfidence: 0.98, area: "machine", ready: false, size: 0.2, urgency: 1, risk: 0.2, archive: false, archiveReason: "none", confidence: 0.8, at: NOW.toISOString(), model: "typesafe-ai/jev" });
    expect(c?.signals?.archive).toEqual({ answer: false, confidence: 0.98 });
    expect(lines).toEqual([]);
  });

  it("answers null without a word when the machine has no Jev credential", async () => {
    const lines: string[] = [];
    const c = await createIssueClassifier({ runs: runs(new RunNoCredentialError("jev: no Jev credential")).port, log: (l) => lines.push(l) }).classify(issue);
    expect(c).toBeNull();
    expect(lines).toEqual([]);
  });

  it("answers null and says why when the run fails, the queue is full or the day is spent", async () => {
    for (const error of [new RunFailedError("jev: HTTP 500: boom"), new QueueFullError("full"), new RunOverBudgetError("budget"), new Error("docker gone")]) {
      const lines: string[] = [];
      expect(await createIssueClassifier({ runs: runs(error).port, log: (l) => lines.push(l) }).classify(issue)).toBeNull();
      expect(lines).toEqual([expect.stringContaining(`could not classify jira:HAR-7: ${error.message}`)]);
    }
  });
});

describe("a confident question", () => {
  const c = { kind: "question", kindConfidence: 0.96, area: "machine", ready: false, size: 0.2, confidence: 0.27, at: "", model: "m" };
  it("is a question Jev is sure is a question: the kind's own confidence at or above the pack's floor (0.7)", () => {
    // Live, a real question came back kind question 1.00 but ready at 0.60 and area at 0.27: the
    // lowest confidence says nothing about whether it is a question.
    expect(confidentQuestion(c)).toBe(true);
    expect(confidentQuestion({ ...c, kindConfidence: 0.7 })).toBe(true);
    expect(confidentQuestion({ ...c, kindConfidence: 0.69 })).toBe(false);
    expect(confidentQuestion({ ...c, kind: "bug" })).toBe(false);
    expect(confidentQuestion(null)).toBe(false);
  });

  it("takes a repo's override of the kind's bar", () => {
    expect(confidentQuestion({ ...c, kindConfidence: 0.9 }, { kind: { proceed: 0.95 } })).toBe(false);
    expect(confidentQuestion({ ...c, kindConfidence: 0.9 })).toBe(true);
    expect(confidentQuestion({ ...c, kindConfidence: 0.6 }, { kind: { proceed: 0.5 } })).toBe(true);
  });

  it("reads a classification stored before kindConfidence by its lowest confidence", () => {
    const { kindConfidence: _, ...old } = c;
    expect(confidentQuestion({ ...old, confidence: 0.85 })).toBe(true);
    expect(confidentQuestion({ ...old, confidence: 0.27 })).toBe(false);
  });
});
