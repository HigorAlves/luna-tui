// The commands of the ground-truth loop, with their collaborators passed in so a test can fake
// them: harvest (records to cases), dataset push (cases, and with --queue the unlabelled, to Laminar)
// and dataset pull (labelled datapoints to cases). `cli.ts` wires the real log and telemetry.
import type { DecisionRecord, DecisionTruth, PackId } from "@hardness/contracts";
import type { QueueItem, Telemetry } from "@hardness/machine/telemetry";

import { loadCases } from "./cases.ts";
import { casesOfDatapoints, datapointsOf, queueItemsOf } from "./datasets.ts";
import { type HarvestReport, harvest, writeCase } from "./harvest.ts";
import { labelOfAnswer } from "./labels.ts";
import { labelState } from "./records.ts";
import { scrubContext } from "./scrub.ts";

export interface RecordSource {
  list(pack: PackId, options: { since?: Date; withTruth?: boolean }): Promise<DecisionRecord[]>;
}

/** Only the machine's own records unless `all`: an HTTP client's context is not the machine's to turn into a case. A record says whose it is (`origin`);
 *  one written before that field was there is the pipeline's own when it names a `stage`. */
export const ownRecords = (records: DecisionRecord[], all = false): DecisionRecord[] => (all ? records : records.filter((r) => (r.origin !== undefined ? r.origin === "machine" : r.stage !== undefined)));

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
    // The same state check as the label push: no truth, not private, not refused by the scrub, and context kept.
    .filter((r) => labelState(r) === "queue" && !cases.some((c) => c.expect.recordId === r.id))
    // Scrubbed like a harvest: a record the scrub refuses never leaves the machine.
    .flatMap((r) => {
      const scrubbed = scrubContext(r.context);
      return scrubbed.ok ? [{ idempotencyKey: r.id, data: scrubbed.value, target: labelOfAnswer(r.answer), metadata: { pack, source: "record", recordId: r.id, ...(r.traceId ? { traceId: r.traceId } : {}) } }] : [];
    });
  const items = [...queueItemsOf(pack, cases), ...extra];
  return { dataset, queue: { name: options.queue, ...(await telemetry.queue.push(options.queue, items)) } };
}

const QUEUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LabelPushReport {
  pushed: number;
  /** Records a person can label here and nowhere else: private, or refused by the scrub. Named, never sent. */
  localOnly: Array<{ pack: PackId; id: string }>;
}

/** Every `queue`-state record of the machine, of the packs given, to the labelling queue: scrubbed as a harvest is, the model's answer the prefilled target, the record id the key,
 *  and for a record with a priority file the two levels as `metadata.hint`. A person types the command; nothing calls it. The queue is named by its id: the local tool cannot list queues. */
export async function runLabelPush(
  source: { list(pack: PackId, options: { since?: Date }): Promise<DecisionRecord[]> },
  telemetry: Pick<Telemetry, "queue">,
  options: { queue: string; packs: PackId[]; since?: Date; hintOf: (recordId: string) => unknown },
): Promise<LabelPushReport> {
  if (!QUEUE_ID.test(options.queue)) throw new Error(`name the queue by its id (the UUID in its page address): the local tool cannot list queues, so a name like ${JSON.stringify(options.queue)} cannot be found`);
  const report: LabelPushReport = { pushed: 0, localOnly: [] };
  const items: QueueItem[] = [];
  for (const pack of options.packs) {
    for (const r of ownRecords(await source.list(pack, options.since ? { since: options.since } : {}))) {
      const state = labelState(r);
      if (state === "local_only") report.localOnly.push({ pack, id: r.id });
      if (state !== "queue") continue;
      const scrubbed = scrubContext(r.context);
      if (!scrubbed.ok) continue;
      const hint = options.hintOf(r.id);
      items.push({ idempotencyKey: r.id, data: scrubbed.value, target: labelOfAnswer(r.answer), metadata: { pack, source: "record", recordId: r.id, ...(r.traceId ? { traceId: r.traceId } : {}), ...(hint ? { hint } : {}) } });
    }
  }
  if (items.length > 0) report.pushed = (await telemetry.queue.push(options.queue, items)).pushed;
  return report;
}

export interface PullReport {
  written: string[];
  kept: string[];
  skipped: Array<{ taskId: string; reason: string }>;
  /** Records a pulled label was written back to as a queue truth (only with `writeLabels`). */
  labelled: string[];
  /** Records a pulled label could be written back to, which were not (no `writeLabels`). */
  pending: string[];
}

const hasPerson = (record: DecisionRecord): boolean => record.truth?.kind === "person" || (record.truth?.history ?? []).some((entry) => entry.kind === "person") || Object.values(record.truth?.kinds ?? {}).includes("person");

/** The dataset's labelled datapoints as cases, never overwriting one that exists. A datapoint's record id is trusted only for a record that is here, in the `queue` state
 *  with no person's label; any other keeps the case but drops the id. Writing a label back onto the record (a `queue` truth, below any person's) happens only with `writeLabels`,
 *  and every label is handed to `print` before it is written. Without a record source nothing is written back and no id is kept. */
export async function runPull(
  evalsDir: string,
  pack: PackId,
  telemetry: Pick<Telemetry, "datasets">,
  options: { records?: { read(pack: PackId, id: string): Promise<DecisionRecord | null>; setTruth(pack: PackId, id: string, truth: DecisionTruth): Promise<boolean> }; writeLabels?: boolean; print?: (line: string) => void } = {},
): Promise<PullReport> {
  const { cases, skipped } = casesOfDatapoints(pack, await telemetry.datasets.pull(pack));
  const report: PullReport = { written: [], kept: [], skipped, labelled: [], pending: [] };
  for (const files of cases) {
    const { recordId, label } = files.expect;
    const record = recordId && options.records ? await options.records.read(pack, recordId).catch(() => null) : null;
    const trusted = record !== null && labelState(record) === "queue" && !hasPerson(record);
    if (recordId && !trusted) {
      delete files.expect.recordId;
      delete files.expect.traceId;
      report.skipped.push({ taskId: files.id, reason: "the datapoint names a record that is not waiting for a label here: the case is kept without the record id" });
    }
    (writeCase(evalsDir, pack, files) ? report.written : report.kept).push(files.id);
    if (!trusted || !recordId || !label) continue;
    if (!options.writeLabels) {
      report.pending.push(recordId);
      continue;
    }
    options.print?.(`label ${pack}/${recordId}: ${Object.entries(label).map(([q, v]) => `${q}=${JSON.stringify(Object.values(v)[0])}`).join(" ")}`);
    if (await options.records!.setTruth(pack, recordId, { label, source: "person_queue", kind: "queue", at: new Date().toISOString() })) report.labelled.push(recordId);
  }
  return report;
}
