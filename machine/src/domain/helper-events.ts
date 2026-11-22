// The rows the machine writes about the ui-designer helper (RFC 0013, phase 5). They are the machine's own facts: a container may write none of them
// (`reserved-kinds.ts` reserves the whole `build.helper_` prefix), they are not in `STAGE_REPORTS`, and they are logged through a stage's `emit`.
// The Build panel's `picked` set, the evals and the design budget read them; nothing reads a helper's own words.
import type { Locks } from "./delegation.ts";

export const HELPER_EVENT_KINDS = ["build.helper_started", "build.helper_refused", "build.helper_conflict", "build.helper_picked", "build.helper_ended"] as const;
export type HelperEventKind = (typeof HELPER_EVENT_KINDS)[number];

export interface HelperPayloads {
  /** A helper began on its own workspace at the card's tip `base`. */
  "build.helper_started": { slice: number; base: string; branch: string; engine: string; attempt: number; locks: Locks };
  /** The machine would not start or take the helper (the rule's one line, or D4's lock violation). */
  "build.helper_refused": { slice: number; reason: string };
  /** The plumbing pick conflicted: attempt 1 re-runs the helper, attempt 2 ends in `merge_conflict`. `files` are paths only. */
  "build.helper_conflict": { slice: number; attempt: number; files?: string[] };
  /** The machine put the helper's commits on the card's branch: every sha it made, the branch tip after. */
  "build.helper_picked": { slice: number; base: string; helperTip: string; onto: string; picked: string[]; tip: string };
  /** One helper run ended; its tokens (null when the runtime did not count) and minutes are what the design budget counts. */
  "build.helper_ended": { slice: number; attempt: number; outcome: string; tokens: number | null; minutes: number };
}

/** The `build.helper_ended` payload from a run's own result and wall clock, never from a model's text. */
export function helperEnded(slice: number, attempt: number, result: { outcome: string; usage?: { tokens?: { input: number; output: number } | null } }, minutes: number): HelperPayloads["build.helper_ended"] {
  const t = result.usage?.tokens;
  const tokens = t && Number.isInteger(t.input) && Number.isInteger(t.output) && t.input >= 0 && t.output >= 0 ? t.input + t.output : null;
  return { slice, attempt, outcome: result.outcome, tokens, minutes: Math.round(minutes * 10) / 10 };
}
