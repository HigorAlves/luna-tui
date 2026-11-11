// A run's tool calls as the container classified them, in order, and a short digest of them for the proposer. The events are the container's
// `events.jsonl` (an untrusted file): a result that is not the shape of an observation is skipped, never an error. No output text exists here,
// only classes, command spellings, hosts and variable names, so a digest holds nothing a repository's output wrote.
import { Observation } from "@hardness/contracts";

export interface ObservedCall extends Observation {
  /** The call's own result, and not one whose output the observer read as a failure; a call that never settled is not ok. */
  ok: boolean;
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The observed calls of one run: every `tool_result` with a non-empty observation, in the order the results came. */
export function observedCalls(events: unknown[]): ObservedCall[] {
  return events.flatMap((event) => {
    const e = record(event);
    const payload = e?.kind === "tool_result" ? record(e.payload) : null;
    if (!payload) return [];
    const parsed = Observation.safeParse(payload.observation);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return [];
    return [{ ...parsed.data, ok: payload.ok === true && parsed.data.failure === undefined }];
  });
}

/** What the proposer reads about one finished run. */
export interface Digest {
  at: string;
  runId: string;
  pack: string;
  cardId: string;
  outcome: string;
  /** Observed calls in the run, including those the lines leave out. */
  calls: number;
  /** `intent | form | how it ended`, a dash for what is not known. */
  lines: string[];
}

export const DIGEST_LINES = 40;
/** Runs of one repository the digest file keeps. */
export const DIGESTS_KEPT = 8;

export function digestOf(run: Omit<Digest, "calls" | "lines">, calls: ObservedCall[]): Digest {
  const lines = calls
    .filter((c) => c.intent !== undefined || c.form !== undefined || c.errorClass !== undefined)
    .slice(0, DIGEST_LINES)
    .map((c) => `${c.intent ?? "-"} | ${c.form ?? "-"} | ${c.errorClass ?? (c.ok ? "ok" : "failed")}`);
  return { ...run, calls: calls.length, lines };
}

/** The digests the file keeps: the last runs, oldest first. */
export const keepDigests = (digests: Digest[]): Digest[] => digests.slice(-DIGESTS_KEPT);
