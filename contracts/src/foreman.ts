// The foreman's contract: what it may suggest, and the check that drops a suggestion the board cannot take.
// Its context (the question and the board snapshot) is in stage.ts, with the other contexts.
import { z } from "zod";

import { EngineId } from "./engines.ts";
import { type ForemanContext, PackId } from "./stage.ts";

const base = { taskId: z.string().min(1), why: z.string().max(200) };

/** One action the foreman suggests. The person confirms it on the board, and the board makes the call: the foreman has no route to the machine. */
export const ForemanAction = z.union([
  z.object({ kind: z.literal("start"), ...base }),
  z.object({ kind: z.literal("approve"), ...base }),
  z.object({ kind: z.literal("resume"), ...base }),
  z.object({ kind: z.literal("abort"), ...base }),
  z.object({ kind: z.literal("archive"), ...base }),
  z.object({ kind: z.literal("send_back"), ...base, reason: z.string().min(1).max(1000) }),
  /** For a card that is escalated. */
  z.object({ kind: z.literal("retry"), ...base, reason: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal("set_engine"), ...base, pack: PackId, engine: EngineId }),
  /** Answers a card's open questions, keyed by question id. */
  z.object({ kind: z.literal("answer"), ...base, answers: z.record(z.string(), z.string()) }),
  /** Posts a card's open questions to their thread. */
  z.object({ kind: z.literal("post_questions"), ...base }),
]);
export type ForemanAction = z.infer<typeof ForemanAction>;

export const ForemanAnswer = z.object({
  reply: z.string().max(1200),
  actions: z.array(ForemanAction).max(20),
});
export type ForemanAnswer = z.infer<typeof ForemanAnswer>;

/** Why the board cannot take an action, or null when it can. Pure: the machine drops an action that has a problem. */
export function foremanActionProblem(action: ForemanAction, board: ForemanContext["board"]): string | null {
  const card = board.cards.find((c) => c.id === action.taskId);
  if (!card) return `card ${action.taskId} is not on the board`;
  if (action.kind === "approve" && card.gate === null) return `card ${card.id} has no gate to approve`;
  if (action.kind === "retry" && card.escalation === null) return `card ${card.id} is not escalated`;
  if (action.kind === "answer") {
    const ids = Object.keys(action.answers);
    if (ids.length === 0) return `answer for card ${card.id} has no answer`;
    const unknown = ids.find((id) => !card.questions.some((q) => q.id === id));
    if (unknown !== undefined) return `card ${card.id} has no open question ${unknown}`;
  }
  if (action.kind === "post_questions" && card.questions.length === 0) return `card ${card.id} has no open question to post`;
  if (action.kind === "set_engine") {
    const pack = board.packs.find((p) => p.id === action.pack);
    if (!pack) return `pack ${action.pack} is not on the board`;
    if (!pack.allowed.includes(action.engine)) return `pack ${action.pack} does not allow ${action.engine}`;
  }
  return null;
}
