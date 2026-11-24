import { describe, expect, it } from "vitest";

import { type FactoryLaminarSdk, NO_TELEMETRY, factoryTelemetry } from "./telemetry.ts";

function fakeSdk() {
  const calls: Record<string, unknown[]> = { initialize: [], wrap: [], flush: [], aiSdk: [] };
  const sdk: FactoryLaminarSdk = {
    Laminar: {
      initialize: (props) => void calls.initialize!.push(props),
      wrapClaudeAgentQuery: (query) => {
        calls.wrap!.push(query);
        return query;
      },
      flush: async () => void calls.flush!.push(true),
    },
    LaminarAiSdkTelemetry: class {
      constructor(readonly options?: unknown) {
        calls.aiSdk!.push(options);
      }
    } as unknown as FactoryLaminarSdk["LaminarAiSdkTelemetry"],
  };
  return { sdk, calls };
}

describe("factoryTelemetry", () => {
  it("is off without a key and loads nothing", async () => {
    let loaded = 0;
    const telemetry = await factoryTelemetry({}, { load: async () => (loaded++, fakeSdk().sdk) });
    expect(telemetry).toBe(NO_TELEMETRY);
    expect(loaded).toBe(0);
    const query = () => {};
    expect(telemetry.wrapQuery(query)).toBe(query);
    let registered = 0;
    await telemetry.aiSdk(() => void registered++);
    expect(registered).toBe(0);
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });

  it("initializes Laminar at the address the machine passed, wraps query(), registers the AI SDK once and flushes", async () => {
    const { sdk, calls } = fakeSdk();
    const env = { LMNR_PROJECT_API_KEY: "k", LMNR_BASE_URL: "http://host.docker.internal", LMNR_HTTP_PORT: "8000", LMNR_GRPC_PORT: "8001", LMNR_SPAN_CONTEXT: "ctx" };
    const telemetry = await factoryTelemetry(env, { load: async () => sdk });
    expect(telemetry.on).toBe(true);
    expect(calls.initialize).toEqual([{ projectApiKey: "k", baseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001, instrumentModules: {} }]);
    const query = () => {};
    expect(telemetry.wrapQuery(query)).toBe(query);
    expect(calls.wrap).toEqual([query]);
    const registered: unknown[] = [];
    await telemetry.aiSdk((integration) => void registered.push(integration));
    await telemetry.aiSdk((integration) => void registered.push(integration));
    expect(registered).toHaveLength(1);
    expect(calls.aiSdk).toHaveLength(1);
    await telemetry.flush();
    expect(calls.flush).toEqual([true]);
  });

  it("falls back to off, with a warning, when the SDK cannot be loaded or initialized", async () => {
    const warnings: string[] = [];
    const telemetry = await factoryTelemetry({ LMNR_PROJECT_API_KEY: "k" }, { load: async () => { throw new Error("no module"); }, warn: (line) => warnings.push(line) });
    expect(telemetry).toBe(NO_TELEMETRY);
    expect(warnings).toEqual(["laminar: traces off for this run: no module"]);
  });
  it("keeps whatever the SDK's import adds to the environment (a .env in the worktree) out of the run", async () => {
    const { sdk } = fakeSdk();
    delete process.env.LMNR_TEST_PLANTED;
    const telemetry = await factoryTelemetry({ LMNR_PROJECT_API_KEY: "k" }, {
      load: async () => {
        process.env.LMNR_TEST_PLANTED = "https://evil.example";
        return sdk;
      },
    });
    expect(telemetry.on).toBe(true);
    expect(process.env.LMNR_TEST_PLANTED).toBeUndefined();
  });
});
