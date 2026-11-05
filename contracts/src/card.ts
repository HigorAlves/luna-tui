// The card's entry contract in the v2.2 diagram (`create_card`), as schemas. `NewTaskInput` (api.ts)
// accepts the fields; since wave 14 the machine stores them (`cardFieldsOf`, machine/src/domain/card-fields.ts).
import { z } from "zod";

import { TaskSource } from "./stage.ts";

/** Ids, names and types are short; permalinks and urls are longer; lists are bounded. The machine reads none of these before wave 14. */
const short = z.string().max(200);
const long = z.string().max(2000);
const web = z.string().max(2000).regex(/^https?:\/\//i, "must be an http or https url");

/** What triage weighs a filer's hint at, against its own reading (0.5 = half). Triage applies it from wave 9. */
export const HINT_WEIGHT = 0.5;

/** What the filer says about the card. Hints are weighed, never trusted outright. */
export const CardHints = z.object({
  kind: short.optional(),
  size: short.optional(),
  urgency: short.optional(),
  risk: short.optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type CardHints = z.infer<typeof CardHints>;

export const Reporter = z.object({ id: short, channel: short.optional(), name: short.optional() });
export type Reporter = z.infer<typeof Reporter>;

/** Where the card came from: a Slack permalink or thread, a ticket. */
export const CardSource = z.object({
  type: short,
  permalink: long.optional(),
  threadId: short.optional(),
  ticketId: short.optional(),
});
export type CardSource = z.infer<typeof CardSource>;

/** The machine of the diagram that created the card. */
export const OriginMachine = z.enum(["conversation", "tickets", "backlog", "manual", "automation"]);
export type OriginMachine = z.infer<typeof OriginMachine>;

/** A reference to a file, never its content. */
export const CardAttachment = z.object({ name: short, url: web, mediaType: short.optional(), size: z.number().int().min(0).optional() });
export type CardAttachment = z.infer<typeof CardAttachment>;

/** The optional fields `create_card` adds to a new task; spread into `NewTaskInput`. */
export const CardEntryFields = {
  /** Every place the card was reported from: a tracker or Slack source of the machine, or the diagram's own shape. */
  sources: z.array(z.union([TaskSource, CardSource])).max(20).optional(),
  reporter: Reporter.optional(),
  hints: CardHints.optional(),
  originMachine: OriginMachine.optional(),
  attachments: z.array(CardAttachment).max(20).optional(),
  project: short.optional(),
  owners: z.array(short).max(20).optional(),
  followers: z.array(short).max(50).optional(),
  links: z.record(short, long).optional(),
};

/** What a card keeps of the entry contract (`cardFieldsOf`). A row written before wave 14 reads as one source and empty lists. */
export interface CardFields {
  /** Every report of the card; the first is the card's own `source`, kept for every reader that knows one, and never changes. */
  sources: (TaskSource | CardSource)[];
  reporter: Reporter | null;
  hints: CardHints | null;
  originMachine: OriginMachine | null;
  attachments: CardAttachment[];
  project: string | null;
  owners: string[];
  followers: string[];
  links: Record<string, string>;
  /** The thread or ticket history Intake fetched, flat and capped; absent before a card started. */
  history?: { author: string | null; text: string; at: string | null }[];
  /** What context setup resolved, kept to compare with what a person later changes. */
  /** How many reports the card stands for: 1, and one more for each duplicate merged into it. */
  demand?: number;
  /** The duplicates merged into this card (their cards are archived), newest last. */
  merged?: { id: string }[];
  /** The `intake_dedup` decision that judged this card and the slot it was in, for the ground truth of a merge or an undo. */
  dedup?: { recordId: string; slot: number };
  resolved?: { repoPath: string | null; project: string | null; at: string };
}
