// What the ship monitor remembers between polls and across a machine restart: the last activity
// it handled, the replies and fix rounds spent, and whether the Evidence Pack is already
// published. A machine-written JSON file under `<stateDir>/tasks/<taskId>/`, so the task's state
// sweep removes it with the task. A damaged file is read as no cursor: the monitor starts over.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

/** The activity ids kept; older ones fall off, and `since` keeps them from coming back. */
export const SEEN_CAP = 500;

const ShipCursorSchema = z.object({
  schema: z.literal(1),
  pr: z.object({ slug: z.string(), number: z.number().int() }),
  since: z.string().nullable(),
  seen: z.array(z.string()),
  threads: z.record(z.string(), z.object({ replies: z.number().int(), lastAt: z.string(), fixRounds: z.number().int().optional() })),
  fixRounds: z.number().int(),
  ciReruns: z.number().int(),
  rebases: z.number().int(),
  published: z.object({ sha: z.string() }).nullable(),
  /** When the monitor first started on this PR, for the longest wait. */
  startedAt: z.string().optional(),
  /** The machine asked GitHub to merge (or queued the PR): a merge seen later is its own. */
  mergeRequested: z.boolean().optional(),
  /** The PR sits in the repo's merge queue: the monitor does not ask to merge it again. */
  queued: z.boolean().optional(),
  /** The checks left failure since the last red was handled: the same run id coming back red is a new red (GitHub keeps the run id across a re-run). */
  ciCycled: z.boolean().optional(),
  /** The red CI the loop last handled (`<head>:<run ids>`): the same red is not asked about twice. */
  ciKey: z.string().optional(),
  /** Decisions awaiting the PR's outcome (RFC 0005 wave 7): what was asked, the record, and what has happened since. */
  decisions: z
    .array(z.object({ pack: z.enum(["event_class", "comment_intent"]), recordId: z.string(), choice: z.string(), threadId: z.string().optional(), further: z.boolean().optional() }))
    .optional(),
  /** Threads the machine itself resolved in a fix round: its own resolution says nothing about what the reviewer meant. */
  resolvedByMachine: z.array(z.string()).optional(),
  /** The blockers last noted, so a poll that finds the same ones says nothing. */
  lastBlockers: z.string().optional(),
  /** GitHub itself answered `reviewDecision: REVIEW_REQUIRED` for this PR at some poll: a review is required here (kept as evidence the rule reader may not see). */
  reviewRequiredSeen: z.boolean().optional(),
  /** The classes facts decided at the last poll (`conflict`, `base_moved`, `freeze`, `blocked_by_other_pr`): one `ship.event` per change. */
  lastEvents: z.array(z.string()).optional(),
  /** Comments read by the `pr_reply` read step on this PR (at most `MAX_PR_READS`). */
  reads: z.number().int().optional(),
  /** The fixes pushed: the commit, the scope, a line, and the scenarios the fix may have changed. */
  fixes: z.array(z.object({ sha: z.string(), scope: z.enum(["in_place", "re_verify_partial"]), summary: z.string(), affected: z.array(z.object({ id: z.string(), text: z.string(), result: z.string() })) })).optional(),
  /** `ship.ready` was logged: readiness is announced the first time it is true. */
  readyNoted: z.boolean().optional(),
});
export type ShipCursor = z.infer<typeof ShipCursorSchema>;

export function emptyCursor(pr: { slug: string; number: number }): ShipCursor {
  return { schema: 1, pr, since: null, seen: [], threads: {}, fixRounds: 0, ciReruns: 0, rebases: 0, published: null };
}

const fileOf = (stateDir: string, taskId: string) => join(stateDir, "tasks", taskId, "ship.json");

export async function loadCursor(stateDir: string, taskId: string): Promise<ShipCursor | null> {
  let text: string;
  try {
    text = await readFile(fileOf(stateDir, taskId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = ShipCursorSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveCursor(stateDir: string, taskId: string, cursor: ShipCursor): Promise<void> {
  const file = fileOf(stateDir, taskId);
  await mkdir(join(stateDir, "tasks", taskId), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...cursor, seen: cursor.seen.slice(-SEEN_CAP) }));
  await rename(tmp, file);
}
