import type { DecisionRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { verdictRows } from "./rows-verdicts.ts";

function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    schema: 1,
    id: "rec-1",
    pack: "ci_failure_class",
    engine: "claude:haiku",
    model: "m",
    at: "2026-04-01T08:00:00Z",
    client: null,
    taskId: "t-1",
    context: { secret: "SECRET-TEXT" },
    answer: { class: { choice: "flake", confidence: 0.8 } },
    verdicts: { class: "proceed" },
    overall: "proceed",
    traceId: null,
    ...over,
  } as DecisionRecord;
}

const truth = (label: Record<string, unknown>, kind?: "person" | "fact" | "outcome" | "queue") => ({ label, source: "ci_rerun", at: "2026-04-02T00:00:00Z", ...(kind ? { kind } : {}) });

describe("verdictRows", () => {
  it("gives nothing for a record with no truth", () => {
    expect(verdictRows(record(), { hasCard: true })).toEqual([]);
  });

  it("gives a Verdict and a VerdictOn edge for a choice a fact settled", () => {
    const rows = verdictRows(record({ truth: truth({ class: { choice: "real" } }) }), { hasCard: true });
    expect(rows).toEqual([
      {
        type: "Verdict",
        data: { slug: "verdict:ci_failure_class/rec-1/class", pack: "ci_failure_class", question: "class", answer: "flake", confidence: 0.8, truth: "real", truth_source: "outcome", decided_at: "2026-04-01T08:00:00.000Z" },
      },
      { edge: "VerdictOn", from: "verdict:ci_failure_class/rec-1/class", to: "card:t-1" },
    ]);
  });

  it("leaves the edge out when the graph holds no card for the record", () => {
    const rows = verdictRows(record({ truth: truth({ class: { choice: "real" } }) }), { hasCard: false });
    expect(rows).toHaveLength(1);
    expect(rows.some((row) => "edge" in row)).toBe(false);
  });

  it("marks a person's word as person, and leaves the edge out without a task", () => {
    const rows = verdictRows(record({ taskId: undefined, truth: truth({ class: { choice: "real" } }, "person") }), { hasCard: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: { truth_source: "person" } });
  });

  it("reads the kind of each question, not only the truth's latest", () => {
    const rows = verdictRows(record({ truth: { ...truth({ class: { choice: "real" } }, "fact"), kinds: { class: "person" } } }), { hasCard: true });
    expect(rows[0]).toMatchObject({ data: { truth_source: "person" } });
  });

  it("writes yes/no answers as yes or no, with confidence from p", () => {
    const rows = verdictRows(record({ pack: "worth_learning", answer: { worth: { value: true, p: 0.9 } }, truth: truth({ worth: { value: false } }) }), { hasCard: true });
    expect(rows[0]).toMatchObject({ type: "Verdict", data: { answer: "yes", truth: "no", confidence: 0.9 } });
  });

  it("writes a score as a number string", () => {
    const rows = verdictRows(record({ pack: "size_estimate", answer: { est_loc: { score: 2.4, confidence: 0.5 } }, truth: truth({ est_loc: { score: 3 } }) }), { hasCard: true });
    expect(rows[0]).toMatchObject({ data: { answer: "2.4", truth: "3", confidence: 0.5 } });
  });

  it("skips a question whose truth is only a set of possible labels, or that has no answer", () => {
    expect(verdictRows(record({ truth: truth({ class: { choice: ["real", "infra"] } }) }), { hasCard: true })).toEqual([]);
    expect(verdictRows(record({ truth: truth({ other: { choice: "x" } }) }), { hasCard: true })).toEqual([]);
  });

  it("keeps no context", () => {
    expect(JSON.stringify(verdictRows(record({ truth: truth({ class: { choice: "real" } }) }), { hasCard: true }))).not.toContain("SECRET-TEXT");
  });
});
