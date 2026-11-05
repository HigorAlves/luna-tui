// The commands of the ground-truth loop, with their collaborators passed in so a test can fake
// them: harvest (records to cases), dataset push (cases, and with --queue the unlabelled, to Laminar)
// and dataset pull (labelled datapoints to cases). `cli.ts` wires the real log and telemetry.
import type { DecisionRecord, PackId } from "@hardness/contracts";
import type { Telemetry } from "@hardness/machine/telemetry";

import { loadCases } from "./cases.ts";
import { casesOfDatapoints, datapointsOf, queueItemsOf } from "./datasets.ts";
import { type HarvestReport, harvest, writeCase } from "./harvest.ts";
import { labelOfAnswer } from "./labels.ts";
import { scrubContext } from "./scrub.ts";

export interface RecordSource {
  list(pack: PackId, options: { since?: Date; withTruth?: boolean }): Promise<DecisionRecord[]>;
}

/** Only the pipeline's own records (they name a `stage`) unless `all`: an HTTP client's context is not the machine's to turn into a case. */
export const ownRecords = (records: DecisionRecord[], all = false): DecisionRecord[] => (all ? records : records.filter((r) => r.stage !== undefined));

export async function runHarvest(evalsDir: string, pack: PackId, source: RecordSource, options: { since?: Date; withTruth?: boolean; all?: boolean }): Promise<HarvestReport> {
  const { all, ...filters } = options;
  return harvest(evalsDir, pack, ownRecords(await source.list(pack, filters), all));
}

export interface PushReport {
  dataset: { name: string; pushed: number };
  queue?: { name: string; pushed: number };
}

/** Every case of the pack to the dataset named for it; with a queue, the cases awaiting a label (and with `records`, the unlabelled records not yet cases) to the queue. */
export async function runPush(evalsDir: string, pack: PackId, telemetry: Pick<Telemetry, "datasets" | "queue">, options: { queue?: string; records?: DecisionRecord[]; all?: boolean } = {}): Promise<PushReport> {
  const cases = loadCases(evalsDir, pack);
  const dataset = { name: pack as string, ...(await telemetry.datasets.push(pack, datapointsOf(pack, cases))) };
  if (!options.queue) return { dataset };
  const extra = ownRecords(options.records ?? [], options.all)
    .filter((r) => !r.truth && !cases.some((c) => c.expect.recordId === r.id))
    // Scrubbed like a harvest: a record the scrub refuses never leaves the machine.
    .flatMap((r) => {
      const scrubbed = scrubContext(r.context);
      return scrubbed.ok ? [{ idempotencyKey: r.id, data: scrubbed.value, target: labelOfAnswer(r.answer), metadata: { pack, source: "record", recordId: r.id, ...(r.traceId ? { traceId: r.traceId } : {}) } }] : [];
    });
  const items = [...queueItemsOf(pack, cases), ...extra];
  return { dataset, queue: { name: options.queue, ...(await telemetry.queue.push(options.queue, items)) } };
}

export interface PullReport {
  written: string[];
  kept: string[];
  skipped: Array<{ taskId: string; reason: string }>;
}

/** The dataset's labelled datapoints as cases, never overwriting one that exists. */
export async function runPull(evalsDir: string, pack: PackId, telemetry: Pick<Telemetry, "datasets">): Promise<PullReport> {
  const { cases, skipped } = casesOfDatapoints(pack, await telemetry.datasets.pull(pack));
  const report: PullReport = { written: [], kept: [], skipped };
  for (const files of cases) (writeCase(evalsDir, pack, files) ? report.written : report.kept).push(files.id);
  return report;
}
