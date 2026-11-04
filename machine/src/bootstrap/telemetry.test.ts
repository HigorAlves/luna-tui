// machine/src/bootstrap/telemetry.test.ts
import { describe, expect, it } from "vitest";

import { buildTelemetry, tracesFromEnv } from "./telemetry.ts";

describe("buildTelemetry", () => {
  it("is the no-op when traces are off, without touching the SDK", async () => {
    let loaded = 0;
    const telemetry = await buildTelemetry({ mode: "off" }, { load: async () => (loaded++, {}) as never });
    expect(telemetry.mode).toBe("off");
    expect(loaded).toBe(0);
  });

  it("falls back to the no-op, with a warning, when the SDK cannot be loaded or initialized", async () => {
    const warnings: string[] = [];
    const telemetry = await buildTelemetry(
      { mode: "metadata", laminar: { projectApiKey: "k", baseUrl: "http://localhost", stageBaseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001 } },
      { load: async () => { throw new Error("Cannot find module '@lmnr-ai/lmnr'"); }, warn: (line) => warnings.push(line) },
    );
    expect(telemetry.mode).toBe("off");
    expect(warnings).toEqual(["laminar: traces off: Cannot find module '@lmnr-ai/lmnr'"]);
  });

  it("reads the evals runner's config from the environment", () => {
    expect(tracesFromEnv({ HOME: "/home/nobody" })).toEqual({ mode: "off" });
    expect(tracesFromEnv({ HOME: "/home/nobody", LMNR_PROJECT_API_KEY: "k" })).toMatchObject({ mode: "metadata" });
  });
});
