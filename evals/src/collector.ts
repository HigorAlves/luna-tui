// The eval runner's check that the local trace collector answers, before the SDK is loaded: one line and no
// traces when it does not, never a stack trace. The probe itself is the machine's (`probeCollector`).
import { COLLECTOR_HINT, type CollectorProbe, type TracesConfig, probeCollector } from "@hardness/machine/telemetry";

export const unreachableLine = (address: string): string => `traces: the collector at ${address} does not answer; this run leaves no traces (${COLLECTOR_HINT})`;

export type CollectorGate = { ok: true } | { ok: false; line: string };

/** `ok` when traces are off or the collector answers; else the one line to print. */
export async function collectorGate(traces: TracesConfig, probe: (traces: TracesConfig) => Promise<CollectorProbe> = (t) => probeCollector(t, { timeoutMs: 1500 })): Promise<CollectorGate> {
  if (traces.mode === "off") return { ok: true };
  const found = await probe(traces);
  return found.ok ? { ok: true } : { ok: false, line: unreachableLine(found.address) };
}
