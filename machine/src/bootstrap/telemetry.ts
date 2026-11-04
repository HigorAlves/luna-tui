// machine/src/bootstrap/telemetry.ts
// Which Telemetry the machine runs with: the no-op without a Laminar key, the Laminar adapter
// with one. Exported to the evals runner as `@hardness/machine/telemetry`, so `pnpm eval` reports
// to the same local Laminar the machine does, from the same variables.
import { homedir } from "node:os";

import { type TracesConfig, tracesConfig } from "../config.ts";
import { type LaminarSdk, createLaminarTelemetry } from "../adapters/laminar/index.ts";
import { type Telemetry, noTelemetry } from "../application/telemetry.ts";

export type { Telemetry, RunSpan, RunStart, RunEnd, Evaluation, EvaluationCase } from "../application/telemetry.ts";
export type { TracesConfig } from "../config.ts";

export interface BuildTelemetryDeps {
  /** Loads the SDK; tests pass a fake or a failure. */
  load?: () => Promise<LaminarSdk>;
  warn?: (line: string) => void;
}

/** The Telemetry for `traces`: a backend that cannot be reached at boot leaves the machine running without traces, said once. */
export async function buildTelemetry(traces: TracesConfig, deps: BuildTelemetryDeps = {}): Promise<Telemetry> {
  if (traces.mode === "off") return noTelemetry();
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  try {
    const sdk = deps.load ? await deps.load() : undefined;
    return await createLaminarTelemetry({ ...traces.laminar, mode: traces.mode }, sdk, warn);
  } catch (error) {
    warn(`laminar: traces off: ${error instanceof Error ? error.message : String(error)}`);
    return noTelemetry();
  }
}

/** `MACHINE_TRACES` and the `LMNR_*` variables as the evals runner reads them: the machine's rules, no machine config. */
export function tracesFromEnv(env: NodeJS.ProcessEnv = process.env): TracesConfig {
  return tracesConfig(env, env.HOME ?? homedir());
}
