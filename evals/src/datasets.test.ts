import type { PackId } from "@hardness/contracts";
import { buildContextPackInput } from "@hardness/machine/decisions";
import { describe, expect, it } from "vitest";

import type { EvalCase } from "./cases.ts";
import { casesOfDatapoints, datapointsOf, queueItemsOf } from "./datasets.ts";
import { Expect } from "./expect.ts";

const retro = { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMin: 310 }, runs: 14 } };
const evalCase = (id: string, expect: object): EvalCase => ({ id, pack: "worth_learning" as PackId, input: buildContextPackInput("worth_learning", { ship: retro } as never), expect: Expect.parse({ schema: 1, rubric: "r", ...expect }) });

describe("cases to datapoints and queue items", () => {
  const labelled = evalCase("clear-yes", { label: { worth: { value: true } }, checks: [{ kind: "equals", path: "worth.value", value: true }] });
  const unlabelled = evalCase("rec-6b0f2c52", { review: true, recordId: "rec-uuid", traceId: "t-1", modelAnswer: { worth: { value: true, p: 0.93 } } });

  it("maps each case to a datapoint: taskId the case id, data the context, target the label or {}, metadata the source", () => {
    expect(datapointsOf("worth_learning", [labelled, unlabelled])).toEqual([
      { taskId: "clear-yes", data: { ship: retro }, target: { worth: { value: true } }, metadata: { pack: "worth_learning", source: "case" } },
      { taskId: "rec-6b0f2c52", data: { ship: retro }, target: {}, metadata: { pack: "worth_learning", source: "record", recordId: "rec-uuid", traceId: "t-1" } },
    ]);
  });

  it("sends only the cases awaiting a label to the queue, keyed by the record, the model's answer as the target", () => {
    expect(queueItemsOf("worth_learning", [labelled, unlabelled])).toEqual([
      { idempotencyKey: "rec-uuid", data: { ship: retro }, target: { worth: { value: true } }, metadata: { pack: "worth_learning", source: "record", taskId: "rec-6b0f2c52", recordId: "rec-uuid", traceId: "t-1" } },
    ]);
  });
});

describe("datapoints back to cases", () => {
  it("makes a case of each labelled datapoint, its checks from the target, and reports the rest", () => {
    const out = casesOfDatapoints("worth_learning", [
      { taskId: "good one", data: { ship: retro }, target: { worth: { value: false } }, metadata: { recordId: "r9" } },
      { taskId: "no-label", data: { ship: retro }, target: {} },
      { taskId: "bad-data", data: { ship: { kind: "nope" } }, target: { worth: { value: true } } },
      { taskId: "../../x", data: { ship: retro }, target: { worth: "oops" } },
      { taskId: "...", data: { ship: retro }, target: { worth: { value: true } } },
    ]);
    expect(out.cases.map((c) => c.id)).toEqual(["good-one"]);
    expect(out.cases[0]!.expect).toMatchObject({ checks: [{ kind: "equals", path: "worth.value", value: false }], label: { worth: { value: false } }, recordId: "r9" });
    expect(out.skipped.map((s) => [s.taskId, s.reason.split(":")[0]])).toEqual([
      ["no-label", "no target"],
      ["bad-data", "data is off the pack's context schema"],
      ["../../x", "no target"],
      ["...", "the task id is not usable as a case id"],
    ]);
  });

  it("refuses a pack that is not a decision pack", () => {
    expect(() => casesOfDatapoints("triage", [])).toThrow(/not a decision pack/);
  });
});
