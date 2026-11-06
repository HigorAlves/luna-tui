// The runs' lists of hosts as the machine builds them, shared by the machine's bootstrap and the evals runner (so what an eval measures is what runs).
import type { Config } from "../config.ts";
import { type EgressPolicy, egressPolicy } from "../application/egress-policy.ts";
import type { PolicyStore } from "../application/policy.ts";

/** The machine's trace endpoints a stage may reach, `host:port`: only in full mode (the stage exports spans then). */
export function traceEntriesOf(traces: Config["traces"]): string[] {
  if (traces.mode !== "full") return [];
  const host = new URL(traces.laminar.stageBaseUrl).hostname;
  return [`${host}:${traces.laminar.httpPort}`, `${host}:${traces.laminar.grpcPort}`];
}

/** The runs' lists of hosts, or undefined with `MACHINE_EGRESS=off` (every run then joins an ordinary bridge, said once). */
export function buildEgress(config: Pick<Config, "egress" | "runnerImage" | "traces">, policies: PolicyStore): EgressPolicy | undefined {
  if (!config.egress.enabled) {
    console.warn("MACHINE_EGRESS=off: every run joins an ordinary network, with no allow-list");
    return undefined;
  }
  return egressPolicy({ policies, proxyImage: config.runnerImage, engineHosts: config.egress.engineHosts, traceEntries: traceEntriesOf(config.traces) });
}

