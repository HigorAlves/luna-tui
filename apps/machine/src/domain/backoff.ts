// Retries with a growing wait, inside a stage's abort signal. A checkpoint push that fails is tried again after 1 s, 5 s and 25 s; a push
// that still fails is a note on the run and never fails the stage. Pure apart from the timer, which a caller may replace.

export const PUSH_BACKOFF_MS = [1000, 5000, 25000];

/** A timer the signal cuts short: resolves when the wait is over or the signal aborts. */
const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Runs `attempt` (null is success, a string the error) once, then once more after each delay, stopping at a success or an abort. */
export async function retryWithBackoff(
  attempt: () => Promise<string | null>,
  options: { delaysMs: readonly number[]; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<{ error: string | null; tries: number }> {
  if (options.signal?.aborted) return { error: "aborted", tries: 0 };
  let error: string | null = null;
  let tries = 0;
  for (let i = 0; i <= options.delaysMs.length; i++) {
    if (i > 0) {
      await (options.sleep ? options.sleep(options.delaysMs[i - 1]!) : wait(options.delaysMs[i - 1]!, options.signal));
      if (options.signal?.aborted) break;
    }
    tries += 1;
    error = await attempt();
    if (error === null) break;
  }
  return { error, tries };
}
