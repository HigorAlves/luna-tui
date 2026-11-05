import { describe, expect, it } from "vitest";

import { DecisionRecord } from "./index.ts";

const record = {
  schema: 1,
  id: "6b0f2c52-7a3e-4d0b-9c1e-0a1f2b3c4d5e",
  pack: "worth_learning",
  engine: "claude:haiku",
  model: "claude-haiku-5-5",
  at: "2026-11-04T12:00:00.000Z",
  client: "ship",
  context: { ship: { kind: "retro" } },
  answer: { worth: { value: true, p: 0.93 } },
  verdicts: { worth: "proceed" },
  overall: "proceed",
  traceId: null,
};

describe("DecisionRecord", () => {
  it("round-trips a record without a truth, with the optional fields absent", () => {
    expect(DecisionRecord.parse(record)).toEqual(record);
  });

  it("carries a truth: the label in the answer's shape, where it came from and when", () => {
    const truth = { label: { worth: { value: false } }, source: "retro", at: "2026-11-05T09:00:00.000Z" };
    expect(DecisionRecord.parse({ ...record, taskId: "t1", stage: "ship", truth })).toMatchObject({ taskId: "t1", stage: "ship", truth });
  });

  it("refuses an unknown pack, a schema other than 1 and a missing answer", () => {
    expect(() => DecisionRecord.parse({ ...record, pack: "nope" })).toThrow();
    expect(() => DecisionRecord.parse({ ...record, schema: 2 })).toThrow();
    const { answer: _a, ...without } = record;
    expect(() => DecisionRecord.parse(without)).toThrow();
  });
});
