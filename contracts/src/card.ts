// The card's entry contract in the v2.2 diagram (`create_card`), as schemas. `NewTaskInput` (api.ts)
// accepts the fields; since wave 14 the machine stores them (`cardFieldsOf`, machine/src/domain/card-fields.ts).
import { z } from "zod";

import { TaskSource } from "./stage.ts";

/** Ids, names and types are short; permalinks and urls are longer; lists are bounded. The machine reads none of these before wave 14. */
const short = z.string().max(200);
const long = z.string().max(2000);
/** An http or https address with no whitespace, angle bracket or quote: it can sit in a prompt or a line of markdown without breaking out of it. */
export const WEB_URL = /^https?:\/\/[^\s<>"']+$/i;
const web = z.string().max(2000).regex(WEB_URL, "must be an http or https url without spaces, angle brackets or quotes");

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
  merged?: { id: string; /** What the merge added to this card: only that is taken back on an unmerge. */ sources?: (TaskSource | CardSource)[]; followers?: string[] }[];
  /** What Intake's duplicate check found: the shortlist (by slot, as the decision saw it), the answers, the outcome and the decision record's id (ground truth names it). */
  dedup?: {
    at: string;
    recordId: string | null;
    candidates: { id: string; kind: "open" | "closed" | "backlog"; score: number; slot: number }[];
    answer: Record<string, { choice: string; confidence: number }> | null;
    outcome: "duplicate" | "related" | "ask" | "none" | "skipped";
    /** What a person chose at the gate. */
    chosen?: "duplicate" | "related" | "neither";
  };
  /** The card this one was split from (an id); only the machine sets it, when a person approves a split. Its chain gives the card's depth. */
  splitFrom?: string;
  /** The sources whose audience a child of a split inherits for the duplicate and size lookups (its origin's; never a place to post to). */
  audience?: (TaskSource | CardSource)[];
  /** The cards a split made from this one, and which part of how many this card is. */
  splitInto?: string[];
  splitPart?: { n: number; of: number };
  /** The cards this one waits for (ids), and whether it starts by itself once they are there. */
  dependsOn?: string[];
  startWhenReady?: boolean;
  /** The lowest risk this card may be scored: a child of a split is never riskier than its origin was, only the other way. */
  riskFloor?: "low" | "medium" | "high";
  /** The card and branch this one is stacked on (filled from the dependency rule). */
  base?: { card: string; branch: string };
  /** Cards linked as related to this one (ids). */
  related?: string[];
  /** The card this one was merged into (a card, or a backlog item); the card is `closed`. */
  mergedInto?: string;
  /** A linked ticket's scope or priority changed while the card was before Build: the field names and when, never the ticket's text. Its open gate and the next one carry it. */
  ticketChanged?: { fields: string[]; at: string };
  resolved?: { repoPath: string | null; project: string | null; at: string };
}
