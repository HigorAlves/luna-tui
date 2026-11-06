import { describe, expect, it } from "vitest";

import { collectorGate, unreachableLine } from "./collector.ts";

const traces = { mode: "host" as const, laminar: { projectApiKey: "k", baseUrl: "http://localhost", stageBaseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001 } };

describe("collectorGate", () => {
  it("says nothing when traces are off or the collector answers", async () => {
    expect(await collectorGate({ mode: "off" }, async () => ({ ok: false, address: "x:1" }))).toEqual({ ok: true });
    expect(await collectorGate(traces, async () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("gives the one line the runner prints when the collector does not answer", async () => {
    const gate = await collectorGate(traces, async () => ({ ok: false, address: "localhost:8001" }));
    expect(gate).toEqual({ ok: false, line: "traces: the collector at localhost:8001 does not answer; this run leaves no traces (docker compose --profile observe up -d starts it)" });
    expect(unreachableLine("localhost:8001")).toBe((gate as { line: string }).line);
    expect((gate as { line: string }).line).not.toContain("\n");
  });
});
