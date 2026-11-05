// The shared backlog of the v2.2 diagram: candidates that are not cards yet, from every source, in one ranked list.
import { z } from "zod";

import { CardSource } from "./card.ts";
import { TaskSource } from "./stage.ts";

/** One to three, as wave 8's scoring reads them. */
const score = z.number().min(1).max(3);

export const BacklogSize = z.enum(["XS", "S", "M", "L", "XL"]);
export type BacklogSize = z.infer<typeof BacklogSize>;

export const BacklogScores = z.object({ who: score, what: score, impact: score, time: score, demand: score });
export type BacklogScores = z.infer<typeof BacklogScores>;

/** `POST /backlog`: a candidate to add. Everything is bounded: a source's text is a stranger's. */
export const BacklogAddInput = z.object({
  title: z.string().trim().min(1).max(300),
  text: z.string().max(4000).default(""),
  sources: z.array(z.union([TaskSource, CardSource])).max(20).default([]),
  /** The repository (`owner/name` or a path) the candidate is about; a duplicate found in the backlog is matched within it. */
  repo: z.string().trim().min(1).max(300).nullable().default(null),
  scores: BacklogScores,
  size: BacklogSize,
  dependsOn: z.array(z.string().uuid()).max(20).default([]),
});
export type BacklogAddInput = z.infer<typeof BacklogAddInput>;

/** A backlog item as `GET /backlog` shows it, ranked. */
export interface BacklogEntry {
  id: string;
  title: string;
  text: string;
  sources: (TaskSource | CardSource)[];
  repo: string | null;
  scores: BacklogScores;
  size: BacklogSize;
  demand: number;
  dependsOn: string[];
  addedAt: string;
  assessedAt: string;
  /** Cost of delay over cost of doing. */
  score: number;
  /** Not assessed for `backlog.stale_days`. */
  stale: boolean;
}
