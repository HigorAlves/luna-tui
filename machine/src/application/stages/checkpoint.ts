// A checkpoint of Build: the branch tip pushed to `refs/luna/wip/<branch>` after the red and after every green, so a killed container never
// loses a slice. A failed push is tried again after 1 s, 5 s and 25 s inside the stage's signal; one that still fails is a note on the run and
// never fails the stage. Each push that lands is a `build.checkpoint` row: the sha and what it follows (`red` or `green`).
import { PUSH_BACKOFF_MS, retryWithBackoff } from "../../domain/backoff.ts";
import { type ExecFn, pushCheckpoint } from "./deliver.ts";

/** A checkpoint push that takes longer than this is given up (the final Deliver push is authoritative). */
export const PUSH_TIMEOUT_MS = 60_000;

export interface CheckpointOptions {
  exec: ExecFn;
  branch: string;
  cwd: string;
  follows: "red" | "green";
  signal?: AbortSignal;
  /** The branch tip now. */
  tip: () => Promise<string | null>;
  /** A tip already on the remote is not pushed again. */
  alreadyPushed?: string | null;
  emit?: (kind: "build.checkpoint", payload: { sha: string; follows: "red" | "green" }) => Promise<void>;
  note?: (text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** The sha that landed, or null when nothing was pushed (already there, no tip, or every try failed). */
export async function checkpointPush(options: CheckpointOptions): Promise<string | null> {
  const sha = await options.tip().catch(() => null);
  if (!sha || sha === options.alreadyPushed) return null;
  const { error, tries } = await retryWithBackoff(
    () => pushCheckpoint(options.exec, options.branch, options.cwd, { timeoutMs: PUSH_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) }).catch((e: Error) => e.message),
    { delaysMs: PUSH_BACKOFF_MS, ...(options.signal ? { signal: options.signal } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) },
  );
  if (error !== null) {
    await options.note?.(`checkpoint not pushed after ${tries} ${tries === 1 ? "try" : "tries"}: ${error.slice(0, 300)}`).catch(() => {});
    return null;
  }
  await options.emit?.("build.checkpoint", { sha, follows: options.follows }).catch(() => {});
  return sha;
}
