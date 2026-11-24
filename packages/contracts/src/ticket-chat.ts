// The ticket chat's contract: the talk's turns, the draft it grows, and what the planner answers.
// Its context (the message, the talk so far and the draft) is in stage.ts, with the other contexts.
import { z } from "zod";

/** One turn of the talk. */
export const TicketChatTurn = z.object({ who: z.enum(["person", "planner"]), text: z.string().max(4000) });
export type TicketChatTurn = z.infer<typeof TicketChatTurn>;

/** The ticket as it stands. The planner only drafts it: the board creates the card, after the person confirms. Title and criteria match `NewTaskInput`, so a confirmed draft never fails to post. */
export const TicketDraft = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000),
  criteria: z.array(z.string().trim().min(1).max(500)).max(12),
});
export type TicketDraft = z.infer<typeof TicketDraft>;

/** What the planner answers each turn: a reply, up to four choices, its notes for the next turn and the draft. `ready` needs a draft. */
export const TicketChatAnswer = z
  .object({
    reply: z.string().max(4000),
    /** Short answers the person may pick instead of typing. */
    choices: z.array(z.string().max(200)).max(4),
    /** What the planner learned from the code, carried to the next turn so it need not read it again. */
    notes: z.string().max(6000),
    draft: TicketDraft.nullable(),
    ready: z.boolean(),
  })
  .refine((a) => !a.ready || a.draft !== null, { message: "a ready answer has a draft", path: ["draft"] });
export type TicketChatAnswer = z.infer<typeof TicketChatAnswer>;
