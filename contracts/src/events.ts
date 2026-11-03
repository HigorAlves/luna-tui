// The one event stream a stage run leaves (RFC 0003 §6). Every runtime turns its SDK's stream into
// these; the factory prints them as the transcript the board's watch pane follows and writes them,
// in order, one JSON line each, to /out/events.jsonl. Every line is `{ kind, payload }`, the shape
// the luna tools' events and the stage's notes have always had, so the machine reads them one way.
import { z } from "zod";

import { PackId } from "./stage.ts";

const event = <K extends string, P extends z.ZodRawShape>(kind: K, payload: P) => z.object({ kind: z.literal(kind), payload: z.object(payload) });

const sliceEvent = <K extends string>(kind: K) => event(kind, { id: z.number().int(), title: z.string(), commit: z.string().nullable() });

export const RunEvent = z.discriminatedUnion("kind", [
  /** Text the model wrote, as it wrote it. */
  event("text", { text: z.string() }),
  /** One tool call and the guard's decision on it, refused or not: the audit trail of RFC 0003 §8.
   *  A call no guard looks at (a luna tool, a skill) is `allowed`. `target` is the first line of
   *  what the call names, `fingerprint` a short hash of what an edit or a write changes; `id` is
   *  the SDK's own call id. */
  event("tool_call", {
    id: z.string().optional(),
    tool: z.string(),
    target: z.string(),
    fingerprint: z.string().optional(),
    allowed: z.boolean(),
    reason: z.string().optional(),
  }),
  /** How a call ended, without its output: whether it worked and, when the runtime says, why not. */
  event("tool_result", { id: z.string().optional(), tool: z.string(), ok: z.boolean(), error: z.string().optional() }),
  /** The luna `step` tool: a progress label for the board. */
  event("step", { label: z.string(), n: z.number().int(), of: z.number().int() }),
  /** Tokens and cost as the SDK reported them, per model call or for the run. */
  event("usage", {
    model: z.string(),
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    costUsd: z.number().optional(),
  }),
  /** The provider refused for a usage limit; `resetsAt` is in epoch seconds when it said. */
  event("rate_limit", { resetsAt: z.number().nullable().optional() }),
  /** The run as its runtime started it: the session, the model, and the line the transcript shows. */
  event("session", { id: z.string().optional(), model: z.string().optional(), text: z.string() }),
  /** A fact about the stage the task's log keeps, such as `stage_end`. */
  z.object({ kind: z.literal("note"), payload: z.looseObject({ phase: z.string() }) }),
  /** The luna ledger tools. */
  event("ledger.init", { total: z.number().int() }),
  sliceEvent("slice.red"),
  sliceEvent("slice.green"),
  sliceEvent("slice.committed"),
  sliceEvent("escalation"),
  /** A run this one delegated to another pack or engine, as it started and as it ended. Nothing
   *  emits it yet: `delegate` (RFC 0002 phase 7) will. */
  event("child", {
    phase: z.enum(["start", "end"]),
    runId: z.string(),
    pack: PackId,
    engine: z.string(),
    ok: z.boolean().optional(),
    error: z.string().optional(),
    costUsd: z.number().nullable().optional(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventKind = RunEvent["kind"];
export type RunEventOf<K extends RunEventKind> = Extract<RunEvent, { kind: K }>;

/** The kinds that are the run's own stream: events.jsonl keeps them, the task's log does not. */
const STREAM_KINDS: ReadonlySet<string> = new Set<RunEventKind>(["text", "tool_call", "tool_result", "usage", "rate_limit", "session", "child"]);

/** Whether an events.jsonl line is part of the run's stream rather than a fact for the task's log.
 *  A kind this version does not know is a fact: the machine keeps it, as it always has. */
export const isStreamEvent = (line: { kind: string }): boolean => STREAM_KINDS.has(line.kind);
