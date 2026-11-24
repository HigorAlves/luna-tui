// The docs-drift pack's answer: the doc sections a change made wrong or incomplete. Advisory only. Its
// context is in stage.ts, with the others.
import { z } from "zod";

/** docs_drift: one entry per doc section the change made stale, with why and what to write instead. At most ten. */
export const DocsDriftAnswer = z.object({
  stale: z
    .array(
      z.object({
        /** The doc's path in the worktree. */
        doc: z.string().min(1),
        /** The heading the stale text sits under, or null for the whole doc. */
        section: z.string().nullable(),
        why: z.string().max(300),
        suggestion: z.string().max(300),
      }),
    )
    .max(10),
});
export type DocsDriftAnswer = z.infer<typeof DocsDriftAnswer>;
