// The brain's journal, in the machine's own state: `<stateDir>/brain/journal.json` holds every row the projector wrote to the graph and how far it got,
// since the machine prunes the records the rows came from and a rebuild loads these back. The folder is 0700, the file 0600, a write goes through tmp + fsync + rename, the
// previous file stays as `journal.json.bak`, and writes are served one at a time. A missing file is the empty state. A file that is there and cannot be read is an error, never the
// empty state: the next write would replace the only copy of what the brain was given.
import { access, copyFile, link, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { BrainJournal, BrainState } from "../../application/brain-projector.ts";
import { readRegularFile } from "./bounded.ts";

const READ_CAP = 256 * 1024 * 1024;

const State = z.object({
  cursor: z.object({ tasks: z.string().nullable(), verdicts: z.string().nullable(), claims: z.string().nullable().default(null), wiki: z.record(z.string(), z.string()).default({}) }),
  nodes: z.record(z.string(), z.object({ type: z.string(), data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) })),
  edges: z.array(z.object({ edge: z.string(), from: z.string(), to: z.string() })),
  rebuild: z.literal(true).optional(),
  forgotten: z.array(z.string()).optional(),
});

const emptyState = (): BrainState => ({ cursor: { tasks: null, verdicts: null, claims: null, wiki: {} }, nodes: {}, edges: [] });

export function brainJournal(stateDir: string): BrainJournal {
  const folder = join(stateDir, "brain");
  const path = join(folder, "journal.json");
  const backup = `${path}.bak`;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: async () => {
      let text: string;
      try {
        text = await readRegularFile(path, READ_CAP);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // A journal that is gone next to its previous generation was lost, not never written: never start empty over it.
          if (await access(backup).then(() => true, () => false)) throw new Error(`the brain's journal at ${path} is missing but its previous copy ${backup} is there; copy it back to journal.json to go on`);
          return emptyState();
        }
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
    write: (state, options) => {
      const run = queue.then(async () => {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        const handle = await open(tmp, "w", 0o600);
        try {
          await handle.writeFile(JSON.stringify(state));
          await handle.sync();
        } finally {
          await handle.close();
        }
        // The current file becomes the .bak as a second name for the same file, not a move: `journal.json` is there at every instant,
        // so a crash between the steps never leaves the folder without it. The rename after it is atomic.
        await unlink(backup).catch(() => undefined);
        // A forget keeps no previous generation: it would hold the rows that were just erased.
        if (!options?.dropPrevious) {
          await link(path, backup).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return; // the first write: nothing to keep
            await copyFile(path, backup); // a file system with no hard links
          });
        }
        await rename(tmp, path);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
