// The Laminar loop's mapping: cases to datapoints (a dataset named for the pack), unlabelled cases
// to labeling-queue items (the model's own answer prefilled as the target), and labelled datapoints
// back to cases. A pulled datapoint is untrusted input: its data is parsed with the pack's context
// schema before anything is built from it, its taskId becomes a case id only after sanitising, and
// nothing from it reaches a shell. Pure; the CLI sends the results through the telemetry port.
import type { PackId } from "@hardness/contracts";
import type { Datapoint, QueueItem } from "@hardness/machine/telemetry";
import { type ContextPackId, contextSchema, isContextPack } from "@hardness/machine/decisions";

import type { EvalCase } from "./cases.ts";
import { TOKEN_SHAPE, scrubContext } from "./scrub.ts";
import { type CaseFiles, caseIdOf, caseOf } from "./harvest.ts";
import { type Label, checkLabel, checksOf, labelOfAnswer } from "./labels.ts";

/** What a case gave the pack: its input's context under the pack's own key, without the project context. */
export function contextOf(evalCase: EvalCase): Record<string, unknown> {
  return Object.fromEntries(Object.entries(evalCase.input.context).filter(([key, value]) => key !== "projectContext" && value !== undefined && value !== null));
}

const sourceOf = (evalCase: EvalCase) => (evalCase.expect.recordId ? "record" : "case");

/** Every case of a pack as a datapoint: taskId the case id, data the context, target the label ({} when unlabelled). */
export function datapointsOf(pack: PackId, cases: EvalCase[]): Datapoint[] {
  return cases.map((c) => ({
    taskId: c.id,
    data: contextOf(c),
    target: (c.expect.label as Label | undefined) ?? {},
    metadata: { pack, source: sourceOf(c), ...(c.expect.recordId ? { recordId: c.expect.recordId } : {}), ...(c.expect.traceId ? { traceId: c.expect.traceId } : {}) },
  }));
}

/** The cases a person still has to label, as queue items: keyed by the record (so a re-push is a no-op), the model's answer as the target. */
export function queueItemsOf(pack: PackId, cases: EvalCase[]): QueueItem[] {
  return cases
    .filter((c) => c.expect.review === true)
    .map((c) => ({
      idempotencyKey: c.expect.recordId ?? `${pack}:${c.id}`,
      data: contextOf(c),
      target: c.expect.modelAnswer ? labelOfAnswer(c.expect.modelAnswer) : {},
      metadata: { pack, source: sourceOf(c), taskId: c.id, ...(c.expect.recordId ? { recordId: c.expect.recordId } : {}), ...(c.expect.traceId ? { traceId: c.expect.traceId } : {}) },
    }));
}

const isLabel = (target: unknown): target is Label =>
  target !== null && typeof target === "object" && !Array.isArray(target) && Object.keys(target).length > 0 && Object.values(target).every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry));

export interface PullResult {
  cases: CaseFiles[];
  skipped: Array<{ taskId: string; reason: string }>;
}

/** The datapoints of a pack's dataset as cases: only those with a target, each data parsed with the pack's context schema, a bad one reported and skipped. */
export function casesOfDatapoints(pack: PackId, datapoints: Datapoint[], options: { unlabelled?: boolean } = {}): PullResult {
  const result: PullResult = { cases: [], skipped: [] };
  if (!isContextPack(pack)) throw new Error(`${pack} is not a decision pack`);
  const schema = contextSchema(pack as ContextPackId);
  for (const point of datapoints) {
    const id = caseIdOf(point.taskId);
    if (!id) {
      result.skipped.push({ taskId: point.taskId, reason: "the task id is not usable as a case id" });
      continue;
    }
    if (!isLabel(point.target)) {
      if (!options.unlabelled) result.skipped.push({ taskId: point.taskId, reason: "no target: not labelled yet" });
      continue;
    }
    const data = schema.safeParse(point.data);
    if (!data.success) {
      result.skipped.push({ taskId: point.taskId, reason: `data is off the pack's context schema: ${data.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      continue;
    }
    // Untrusted input is scrubbed like a harvested record: a refusal skips it, the case is built from the scrubbed value.
    const scrubbed = scrubContext(data.data as Record<string, unknown>);
    if (!scrubbed.ok) {
      result.skipped.push({ taskId: point.taskId, reason: `refused: ${scrubbed.reason}` });
      continue;
    }
    if (TOKEN_SHAPE.test(JSON.stringify(point.target))) {
      result.skipped.push({ taskId: point.taskId, reason: "refused: a token-shaped string in the target" });
      continue;
    }
    // A pulled label is held to the pack's own questions and labels, as the command line's is: anything else is skipped.
    const checked = checkLabel(pack, point.target);
    if (!checked.ok) {
      result.skipped.push({ taskId: point.taskId, reason: `refused: the label is not valid for ${pack}: ${checked.reason}` });
      continue;
    }
    const recordId = typeof point.metadata?.recordId === "string" ? point.metadata.recordId : undefined;
    result.cases.push(caseOf(pack, id, scrubbed.value, checked.label, { review: true, ...(recordId ? { recordId } : {}) }));
  }
  return result;
}

export { checksOf };
