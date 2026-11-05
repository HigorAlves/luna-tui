// What a decision pack call leaves behind (RFC 0005 wave 7): its context, the validated answer and
// the verdicts the pack's own bars give it, so a case can be harvested from a real run and graded
// against what later proved right. The machine writes these under its state dir; nothing leaves it
// unscrubbed.
import { z } from "zod";

import { EngineId } from "./engines.ts";
import { PackId } from "./stage.ts";

const Verdict = z.enum(["proceed", "flag", "ask"]);

/** What a person or a later fact says the answer should have been: one label per question, in the answer's shape. */
export const DecisionTruth = z.object({
  label: z.record(z.string(), z.unknown()),
  /** Where it came from: the fact that settled it (`e2e_rerun`, `plan_approval`) or `person`. */
  source: z.string(),
  at: z.string(),
});
export type DecisionTruth = z.infer<typeof DecisionTruth>;

export const DecisionRecord = z.object({
  schema: z.literal(1),
  id: z.string(),
  pack: PackId,
  engine: EngineId,
  model: z.string(),
  at: z.string(),
  /** Who asked: a pipeline stage's client name (`plan`, `verify`, ...), an HTTP client, or null. */
  client: z.string().nullable(),
  taskId: z.string().optional(),
  stage: z.string().optional(),
  /** The pack's `PackContext` value as the call gave it. */
  context: z.record(z.string(), z.unknown()),
  answer: z.record(z.string(), z.unknown()),
  /** The pack's own bars, no repo overrides: what the model said, not what a repo did with it. */
  verdicts: z.record(z.string(), Verdict),
  overall: Verdict,
  /** The trace the call left, so a case links back to it. */
  traceId: z.string().nullable(),
  truth: DecisionTruth.optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
