// The triage port: a batch of Datadog items in, one verdict per item out. The datadog_triage pack
// (application/stages/datadog-triage-runner.ts) runs it in the stage container; tests pass a fake;
// with agents off, no credential or no image the inbox runs with no triager and items keep their floor.
import type { DatadogItem, DatadogTriage } from "@hardness/contracts";

export type DatadogTriageVerdict = Omit<DatadogTriage, "by" | "triagedAt" | "overridden">;

export interface DatadogTriager {
  /** Verdicts by item id; a skipped item is absent. A batch that produced nothing rejects with `TriageRunError`. */
  triage(items: DatadogItem[], scope: string): Promise<Map<string, DatadogTriageVerdict>>;
}

export const DATADOG_TRIAGE_BATCH = 20;
