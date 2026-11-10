// A run the loop guard ended: its failure starts with `LOOP_STUCK`. The machine escalates it, and the escalation reads what stopped it from the
// `stop` event the run logged, else from the error's own text (`<cause>, the same failure <n> times over <calls> calls`).
import { LOOP_STUCK } from "@hardness/contracts";

export interface LoopStop {
  cause: string;
  failure?: string;
  calls: number;
}

export function loopStop(error: unknown, events: { at?: string; kind: string; payload: Record<string, unknown> }[]): LoopStop | null {
  if (typeof error !== "string" || !error.startsWith(LOOP_STUCK)) return null;
  const stop = events.find((e) => /^(stage\.)?economy\.guard$/.test(e.kind) && e.payload.action === "stop");
  if (stop && typeof stop.payload.cause === "string" && typeof stop.payload.calls === "number") {
    return { cause: stop.payload.cause, ...(typeof stop.payload.failure === "string" ? { failure: stop.payload.failure } : {}), calls: stop.payload.calls };
  }
  const rest = error.slice(LOOP_STUCK.length).replace(/^:\s*/, "");
  const parsed = /^(.*?), the same failure \d+ times over (\d+) calls\s*$/s.exec(rest);
  return { cause: (parsed?.[1] ?? rest).trim(), calls: parsed ? Number(parsed[2]) : 0 };
}
