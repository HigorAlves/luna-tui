// A run the loop guard ended: its failure starts with `LOOP_STUCK`. The machine escalates it, and the escalation reads what stopped it from the
// `stop` event the run logged, else from the error's own text (`<cause>, the same failure <n> times over <calls> calls`).
import { EconomyGuardEvent, LOOP_STUCK } from "@hardness/contracts";

/** The longest cause: what the guard event's schema takes. */
const CAUSE_MAX = 60;

export interface LoopStop {
  cause: string;
  failure?: string;
  calls: number;
}

export function loopStop(error: unknown, events: { at?: string; kind: string; payload: Record<string, unknown> }[]): LoopStop | null {
  if (typeof error !== "string" || !error.startsWith(LOOP_STUCK)) return null;
  // The container wrote the event, so it is read through the schema; one that fails it is as good as absent.
  for (const e of events) {
    if (!/^(stage\.)?economy\.guard$/.test(e.kind) || e.payload.action !== "stop") continue;
    const stop = EconomyGuardEvent.safeParse(e.payload);
    if (stop.success && stop.data.cause !== undefined) return { cause: stop.data.cause, ...(stop.data.failure !== undefined ? { failure: stop.data.failure } : {}), calls: stop.data.calls };
  }
  const rest = error.slice(LOOP_STUCK.length).replace(/^:\s*/, "");
  const parsed = /^(.*?), the same failure \d+ times over (\d+) calls\s*$/s.exec(rest);
  return { cause: (parsed?.[1] ?? rest).trim().slice(0, CAUSE_MAX), calls: parsed ? Number(parsed[2]) : 0 };
}
