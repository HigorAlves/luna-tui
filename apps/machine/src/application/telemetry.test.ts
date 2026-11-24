import { describe, expect, it } from "vitest";

import { noTelemetry } from "./telemetry.ts";

describe("noTelemetry", () => {
  it("is off, answers every call and never links a trace", async () => {
    const telemetry = noTelemetry();
    expect(telemetry.mode).toBe("off");
    const span = telemetry.run({ kind: "stage", pack: "triage", engine: "claude:opus", sessionId: "t1", taskId: "t1", stage: "triage", attempt: 1 });
    span.event("started", { container: "c" });
    expect(span.traceId()).toBeNull();
    expect(span.childEnv()).toEqual({});
    await expect(span.end({ outcome: "pass" })).resolves.toBeUndefined();
    const evaluation = await telemetry.evaluation({ name: "e", groupName: "slack_triage" });
    expect(evaluation.id).toBeNull();
    await expect(evaluation.record({ id: "c1", index: 0, data: {}, scores: { pass: 1 }, traceId: null })).resolves.toBeUndefined();
    await expect(evaluation.finish()).resolves.toBeUndefined();
    await expect(telemetry.flush()).resolves.toBeUndefined();
    await expect(telemetry.datasets.push("risk_score", [{ taskId: "c1", data: {} }])).resolves.toEqual({ pushed: 0 });
    await expect(telemetry.datasets.pull("risk_score")).resolves.toEqual([]);
    await expect(telemetry.queue.push("review", [{ idempotencyKey: "r1", data: {} }])).resolves.toEqual({ pushed: 0 });
  });
});
