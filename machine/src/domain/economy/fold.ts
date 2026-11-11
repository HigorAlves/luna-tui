// What one finished run's events say, as facts. The events are the container's `events.jsonl` (an untrusted file): a line that is not
// the shape a reducer reads is skipped, never an error. Each reducer reads the whole list on its own, so a later slice adds one (what a
// fact's evidence saw, which tools were used) without touching the others.
import { EconomyGuardEvent } from "@hardness/contracts";

export interface RunFacts {
  /** Tool calls the run made and the guard let through. */
  calls: number;
  /** What the loop guard did, in order. */
  guard: EconomyGuardEvent[];
  /** Allowed calls per tool name. */
  tools: Record<string, number>;
}

type Reducer<T> = (events: unknown[]) => T;

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The payloads of the events of one kind. */
function payloads(events: unknown[], kind: string): Record<string, unknown>[] {
  return events.flatMap((event) => {
    const e = record(event);
    const payload = e?.kind === kind ? record(e.payload) : null;
    return payload ? [payload] : [];
  });
}

/** The tool calls the guard allowed, by tool name. */
export const toolsOf: Reducer<Record<string, number>> = (events) => {
  const tools: Record<string, number> = {};
  for (const call of payloads(events, "tool_call")) {
    if (call.allowed !== true || typeof call.tool !== "string") continue;
    tools[call.tool] = (tools[call.tool] ?? 0) + 1;
  }
  return tools;
};

export const guardOf: Reducer<EconomyGuardEvent[]> = (events) =>
  payloads(events, "economy.guard").flatMap((p) => {
    const parsed = EconomyGuardEvent.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });

/** One run's facts from its events. */
export function runFacts(events: unknown[]): RunFacts {
  const tools = toolsOf(events);
  return { calls: Object.values(tools).reduce((sum, n) => sum + n, 0), guard: guardOf(events), tools };
}
