// The stage guard's journal (RFC 0012): SafeAgents writes one JSON line per call it judged into a folder the guard shares with the machine.
// The guard ran beside a stage that read hostile text, and its lines carry that text (`arguments` can hold a secret, `task` is the user's words),
// so the file is untrusted input. Each line is parsed strictly, copies only what a card event needs, and every string is flattened and capped.
// A line of the wrong shape is skipped and counted. Nothing here throws on a bad file: a bad journal is an empty one with a note.
import { z } from "zod";

import { readRegularHead } from "../fs/bounded.ts";
import { safe } from "../../domain/evidence-markdown.ts";

/** The most of a journal the machine reads. */
export const JOURNAL_CAP_BYTES = 4 * 1024 * 1024;
const MAX_SIGNALS = 10;

export type GuardEntry = {
  id: number;
  verdict: "blocked" | "flagged" | "suspicious";
  tool: string;
  signals: { id: string; severity: "low" | "medium" | "high" | "critical"; title: string }[];
  reason: string | null;
};
export type GuardJournal = { entries: GuardEntry[]; skipped: number; truncated: boolean };

const text = (cap: number) => z.string().transform((value) => safe(value).slice(0, cap));

// zod strips unknown keys by default: `arguments`, `task`, `judge`, `model` and any future field are never copied.
const Line = z.object({
  id: z.number().int(),
  verdict: z.enum(["blocked", "flagged", "suspicious"]),
  tool: text(64),
  signals: z
    .array(z.object({ id: text(80), severity: z.enum(["low", "medium", "high", "critical"]), title: text(120) }))
    .default([])
    .transform((list) => list.slice(0, MAX_SIGNALS)),
  reason: text(200).nullish().transform((value) => value ?? null),
});

/** The entries of a journal's text, by id. `cut` says the text ends mid-file: its last line may be partial and is dropped. */
export function parseGuardJournal(content: string, options: { cut?: boolean } = {}): GuardJournal {
  const lines = content.split("\n");
  // A text that ends in a newline has an empty last piece; a cut one has a partial last line.
  if (options.cut) lines.pop();
  const entries: GuardEntry[] = [];
  let skipped = 0;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    const line = Line.safeParse(parsed);
    if (line.success) entries.push(line.data);
    else skipped += 1;
  }
  entries.sort((a, b) => a.id - b.id);
  return { entries, skipped, truncated: options.cut === true };
}

/** The journal at `path`: the first 4 MB of a regular file, never following a link. A missing file is empty; a link or anything not a regular file is refused (empty, one skipped). */
export async function readGuardJournal(path: string): Promise<GuardJournal> {
  try {
    const { text: content, truncated } = await readRegularHead(path, JOURNAL_CAP_BYTES);
    return parseGuardJournal(content, { cut: truncated });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], skipped: 0, truncated: false };
    return { entries: [], skipped: 1, truncated: false };
  }
}
