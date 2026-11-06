// Whether the local trace collector answers: a TCP connect to its REST port and its gRPC port, with no SDK
// loaded, so a collector that is down is a line and not a stack trace. The address is the one the machine's
// own configuration names; nothing else is contacted.
import { connect } from "node:net";

import type { TracesConfig } from "../config.ts";

export type CollectorProbe = { ok: true } | { ok: false; address: string };

function answers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Both ports of the collector `traces` names, REST first. With traces off there is nothing to reach. */
export async function probeCollector(traces: TracesConfig, options: { timeoutMs: number }): Promise<CollectorProbe> {
  if (traces.mode === "off") return { ok: true };
  const host = new URL(traces.laminar.baseUrl).hostname;
  for (const port of [traces.laminar.httpPort, traces.laminar.grpcPort]) {
    if (!(await answers(host, port, options.timeoutMs))) return { ok: false, address: `${host}:${port}` };
  }
  return { ok: true };
}

/** How the collector is started, said wherever it is found down. */
export const COLLECTOR_HINT = "docker compose --profile observe up -d starts it";
