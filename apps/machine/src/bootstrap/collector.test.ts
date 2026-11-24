import { type Server, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { probeCollector } from "./collector.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A local port something answers on. */
const listen = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer((socket) => socket.end());
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

/** A local port nothing answers on: opened, then closed. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const traces = (httpPort: number, grpcPort: number) => ({
  mode: "host" as const,
  laminar: { projectApiKey: "k", baseUrl: "http://127.0.0.1", stageBaseUrl: "http://host.docker.internal", httpPort, grpcPort },
});

describe("probeCollector", () => {
  it("is ok when both the REST port and the gRPC port answer", async () => {
    expect(await probeCollector(traces(await listen(), await listen()), { timeoutMs: 1500 })).toEqual({ ok: true });
  });

  it("names the first port that does not answer", async () => {
    const down = await closedPort();
    expect(await probeCollector(traces(await listen(), down), { timeoutMs: 1500 })).toEqual({ ok: false, address: `127.0.0.1:${down}` });
    expect(await probeCollector(traces(down, await listen()), { timeoutMs: 1500 })).toEqual({ ok: false, address: `127.0.0.1:${down}` });
  });

  it("is ok with traces off: there is nothing to reach", async () => {
    expect(await probeCollector({ mode: "off" }, { timeoutMs: 100 })).toEqual({ ok: true });
  });
});
