// A run's tool calls as the container classified them, in order, and a short digest of them for the proposer. The events are the container's
// `events.jsonl` (an untrusted file): a result that is not the shape of an observation is skipped, never an error. No output text exists here,
// only classes, command spellings, hosts and variable names, so a digest holds nothing a repository's output wrote.
import { Observation } from "@hardness/contracts";

export interface ObservedCall extends Observation {
  /** The call's own result; a call that never settled is not ok. */
  ok: boolean;
  // What the observer does not say today. The families that read them (arg repair, env value, empty probe) stay quiet until it does; the
  // fields are here so those families run over a real shape and are tested from it.
  /** A VCS probe's answer: it listed something (`hit`) or it succeeded with nothing to list (`empty`). */
  probe?: "hit" | "empty";
  /** The test labels a runner was given, whether the runner failed to load one, in the safe charset. */
  labels?: string[];
  labelErr?: boolean;
  /** The variables an output asked for, and the values a command set. */
  needs?: string[];
  sets?: Record<string, string>;
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
    return [{ ...parsed.data, ok: payload.ok === true }];
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
