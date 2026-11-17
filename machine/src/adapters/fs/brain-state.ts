// The brain's journal, in the machine's own state: `<stateDir>/brain/journal.json` holds every row the projector wrote to the graph and how far it got,
// since the machine prunes the records the rows came from and a rebuild loads these back. The folder is 0700, the file 0600, a write goes through tmp + rename,
// and writes are served one at a time. A missing file is the empty state. A file that is there and cannot be read is an error, never the
// empty state: the next write would replace the only copy of what the brain was given.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { BrainJournal, BrainState } from "../../application/brain-projector.ts";
import { readRegularFile } from "./bounded.ts";

const READ_CAP = 256 * 1024 * 1024;

const State = z.object({
  cursor: z.object({ tasks: z.string().nullable(), verdicts: z.string().nullable(), claims: z.string().nullable().default(null), wiki: z.record(z.string(), z.string()).default({}) }),
  nodes: z.record(z.string(), z.object({ type: z.string(), data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) })),
  edges: z.array(z.object({ edge: z.string(), from: z.string(), to: z.string() })),
});

const emptyState = (): BrainState => ({ cursor: { tasks: null, verdicts: null, claims: null, wiki: {} }, nodes: {}, edges: [] });

export function brainJournal(stateDir: string): BrainJournal {
  const folder = join(stateDir, "brain");
  const path = join(folder, "journal.json");
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: async () => {
      let text: string;
      try {
        text = await readRegularFile(path, READ_CAP);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw new Error(`the brain's journal at ${path} cannot be read`);
      }
      let parsed: ReturnType<typeof State.safeParse>;
      try {
        parsed = State.safeParse(JSON.parse(text));
      } catch {
        throw new Error(`the brain's journal at ${path} is not JSON; move it away to start a new one`);
      }
      if (!parsed.success) throw new Error(`the brain's journal at ${path} has the wrong shape; move it away to start a new one`);
      return parsed.data as BrainState;
    },
    write: (state) => {
      const run = queue.then(async () => {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
        await rename(tmp, path);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
