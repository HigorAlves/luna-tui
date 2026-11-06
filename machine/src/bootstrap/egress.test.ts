import { afterEach, describe, expect, it, vi } from "vitest";

import { PolicyStore } from "../application/policy.ts";
import { buildEgress, traceEntriesOf } from "./egress.ts";

const traces = { mode: "full" as const, laminar: { projectApiKey: "k", baseUrl: "http://localhost", stageBaseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001 } };
afterEach(() => vi.restoreAllMocks());

describe("buildEgress", () => {
  it("is the machine's list of hosts for a run, with the engine hosts the owner added", async () => {
    const egress = buildEgress({ egress: { enabled: true, engineHosts: ["gateway.example.net"] }, runnerImage: "img", traces: { mode: "off" } }, new PolicyStore({ warn: () => {} }))!;
    const spec = await egress.for({ repoPath: null, kind: "agent", owners: ["claude"] });
    expect(spec).toMatchObject({ proxyImage: "img", allow: expect.arrayContaining(["api.anthropic.com:443", "gateway.example.net:443", "github.com:443"]) });
  });

  it("is nothing with MACHINE_EGRESS=off, said once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildEgress({ egress: { enabled: false, engineHosts: [] }, runnerImage: "img", traces: { mode: "off" } }, new PolicyStore())).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("gives a stage the two trace ports only in full mode", () => {
    expect(traceEntriesOf(traces)).toEqual(["host.docker.internal:8000", "host.docker.internal:8001"]);
    expect(traceEntriesOf({ ...traces, mode: "metadata" })).toEqual([]);
    expect(traceEntriesOf({ mode: "off" })).toEqual([]);
  });
});
