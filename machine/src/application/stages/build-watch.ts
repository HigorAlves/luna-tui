// The build watch follows an implementing run's /out while its container runs. The container
// cannot push and the machine reads the ledger only after the run, so a slice that turned
// committed is handed to `onCommitted` as it lands.
import { type LedgerSlice, Ledger } from "@hardness/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BuildWatchOptions {
  /** The run's `/out` folder on the host. */
  outDir: string;
  /** Poll interval in ms. */
  every: number;
  /** Called once per slice that became committed with a commit. */
  onCommitted: (slice: LedgerSlice) => Promise<void>;
  log?: (line: string) => void;
}

export interface BuildWatch {
  /** Stops polling, reads the ledger one last time and waits for the handlers. */
  stop(): Promise<void>;
  /** The ids of the slices already handed to `onCommitted`. */
  seen: ReadonlySet<number>;
}

export function buildWatch(options: BuildWatchOptions): BuildWatch {
  const seen = new Set<number>();
  let stopped = false;
  let tick: Promise<void> = Promise.resolve();

  const poll = async (): Promise<void> => {
    let ledger: Ledger;
    try {
      ledger = Ledger.parse(JSON.parse(await readFile(join(options.outDir, "ledger.json"), "utf8")));
    } catch {
      return; // not written yet, or half-written: the next tick retries
    }
    for (const slice of ledger.slices) {
      if (stopped) return;
      if (slice.status !== "committed" || !slice.commit || seen.has(slice.id)) continue;
      seen.add(slice.id);
      try {
        await options.onCommitted(slice);
      } catch (error) {
        options.log?.(`build watch: slice ${slice.id}: ${(error as Error).message}`);
      }
    }
  };

  const timer = setInterval(() => {
    tick = tick.then(() => (stopped ? undefined : poll()));
  }, options.every);

  return {
    seen,
    async stop() {
      clearInterval(timer);
      await tick;
      // One last look: a slice committed just before the container exited is still pushed.
      await poll();
      stopped = true;
    },
  };
}
