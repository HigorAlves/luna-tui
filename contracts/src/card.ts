// The card's entry contract in the v2.2 diagram (`create_card`), as schemas. Nothing is persisted from
// these in wave 8: `NewTaskInput` (api.ts) accepts the fields and ignores them until wave 14 stores them.
import { z } from "zod";

/** What triage weighs a filer's hint at, against its own reading (0.5 = half). Triage applies it from wave 9. */
export const HINT_WEIGHT = 0.5;

/** What the filer says about the card. Hints are weighed, never trusted outright. */
export const CardHints = z.object({
  kind: z.string().optional(),
  size: z.string().optional(),
  urgency: z.string().optional(),
  risk: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type CardHints = z.infer<typeof CardHints>;

export const Reporter = z.object({ id: z.string(), channel: z.string().optional(), name: z.string().optional() });
export type Reporter = z.infer<typeof Reporter>;

/** Where the card came from: a Slack permalink or thread, a ticket. */
export const CardSource = z.object({
  type: z.string(),
  permalink: z.string().optional(),
  threadId: z.string().optional(),
  ticketId: z.string().optional(),
});
export type CardSource = z.infer<typeof CardSource>;

/** The machine of the diagram that created the card. */
export const OriginMachine = z.enum(["conversation", "tickets", "backlog", "manual", "automation"]);
export type OriginMachine = z.infer<typeof OriginMachine>;

export const CardAttachment = z.object({ name: z.string(), url: z.string() });
export type CardAttachment = z.infer<typeof CardAttachment>;

/** The optional fields `create_card` adds to a new task; spread into `NewTaskInput`. */
export const CardEntryFields = {
  sources: z.array(CardSource).optional(),
  reporter: Reporter.optional(),
  hints: CardHints.optional(),
  originMachine: OriginMachine.optional(),
  attachments: z.array(CardAttachment).optional(),
};
