// What a decision pack call leaves behind (RFC 0005 wave 7): its context, the validated answer and
// the verdicts the pack's own bars give it, so a case can be harvested from a real run and graded
// against what later proved right. The machine writes these under its state dir; nothing leaves it
// unscrubbed.
import { z } from "zod";

import { EngineId } from "./engines.ts";
import { PackId } from "./stage.ts";

const Verdict = z.enum(["proceed", "flag", "ask"]);

/** Whose word a label is: a `person` said it, a `fact` settled it, an `outcome` is consistent with the answer but partly caused by it. */
export const TruthKind = z.enum(["person", "queue", "fact", "outcome"]);
export type TruthKind = z.infer<typeof TruthKind>;

/** What a person or a later fact says the answer should have been: one label per question, in the answer's shape. */
export const DecisionTruth = z.object({
  label: z.record(z.string(), z.unknown()),
  /** Where it came from: the fact that settled it (`e2e_rerun`, `plan_approval`) or `person`. */
  source: z.string(),
  at: z.string(),
  /** Absent reads as `fact`. */
  kind: TruthKind.optional(),
  /** A person's note with a label given at the command line (`--note`), redacted before it is kept. */
  note: z.string().max(500).optional(),
  /** Every label the truth took, oldest first, at most 20: a second fact adds to the first. */
  history: z.array(z.object({ label: z.record(z.string(), z.unknown()), source: z.string(), kind: TruthKind, at: z.string() })).max(20).optional(),
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
  /** Who made the call: set in process by the machine's own callers, never from a request header. Absent on an older record. */
  origin: z.enum(["machine", "client"]).optional(),
  /** A private conversation: its text is not in `context`, and no case is made of it. */
  private: z.boolean().optional(),
  /** The repository's folder name, never its path. */
  repo: z.string().optional(),
  /** The verdict under the repository's own bars, which is what the machine did; `verdicts` and `overall` keep the pack's own. */
  acted: z.object({ overall: Verdict, below: z.array(z.string()), overrides: z.boolean() }).optional(),
  usage: z.object({ costUsd: z.number().nullable(), durationMs: z.number().nullable(), movedFrom: EngineId.optional() }).optional(),
  /** How many strings a redactor changed before the record was written. */
  redacted: z.number().int().nonnegative().optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
