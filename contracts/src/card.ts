// The card's entry contract in the v2.2 diagram (`create_card`), as schemas. Nothing is persisted from
// these in wave 8: `NewTaskInput` (api.ts) accepts the fields and ignores them until wave 14 stores them.
import { z } from "zod";

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

export const CardAttachment = z.object({ name: short, url: web });
export type CardAttachment = z.infer<typeof CardAttachment>;

/** The optional fields `create_card` adds to a new task; spread into `NewTaskInput`. */
export const CardEntryFields = {
  sources: z.array(CardSource).max(20).optional(),
  reporter: Reporter.optional(),
  hints: CardHints.optional(),
  originMachine: OriginMachine.optional(),
  attachments: z.array(CardAttachment).max(20).optional(),
};
