// Drafts that wait for a person. The machine never posts one: each is stored on the ticket object and a tap posts it. The assessment comment
// and the needs-info comment are built by script in fixed words and numbers; the decline reply is written by the `ticket_reply` pack. Every
// text goes through `postable()` and is refused when it carries a token-shaped string, whether it came from the pack or from an edit.
// What was done to a draft (edited, ignored) is kept on it.
import type { SplitChild, TicketContext } from "@hardness/contracts";

import { carriesSecret, postable } from "../domain/postable.ts";
import { type Recommendation, recommend } from "../domain/ticket-recommend.ts";
import type { TicketScoreResult } from "../domain/ticket-score.ts";
import type { AssessmentRecord } from "./ticket-assess.ts";

export interface Draft {
  id: string;
  ticket: string;
  kind: "assessment" | "needs_info" | "decline" | "not_ours" | "handover" | "reminder" | "park" | "split";
  /** `waiting` for a tap; `edited` is still waiting, with the person's text; `ignored` is kept and never posted. */
  status: "waiting" | "edited" | "ignored" | "posting" | "posted";
  text: string;
  /** The machine's own text, kept beside an edit. */
  original?: string;
  history: Array<{ at: string; did: "edited" | "ignored" | "posted"; from: string }>;
  /** A split draft: the proposed children, and the ones the tap already made (position and key), so a retry goes on and never makes a child twice. */
  children?: SplitChild[];
  created?: Array<{ n: number; key: string }>;
}

const fresh = (ticket: string, kind: Draft["kind"], text: string): Draft => ({ id: `${ticket}:${kind}`, ticket, kind, status: "waiting", text: postable(text), history: [] });

const fixed = (n: number, digits = 2) => n.toFixed(digits);

export function assessmentDraft(ticket: string, r: AssessmentRecord, recommended: Recommendation | null, size: { estLoc: number; estFiles: number } | null = null): Draft {
  return fresh(ticket, "assessment", `Assessed: priority ${r.priority}, size ${r.size}, blast radius ${r.blastRadius}, score ${fixed(r.score)} (cost of delay ${fixed(r.costOfDelay, 1)} over cost of doing ${fixed(r.costOfDoing, 1)}).${recommended ? ` Recommended: ${recommended.replace(/_/g, " ")}.` : ""}${size ? ` Estimated size: about ${Math.round(size.estLoc)} lines in ${Math.round(size.estFiles)} files.` : ""}`);
}

/** The proposal of a split for a ticket: numbered, each with the estimate and what it comes after. Machine-built from model-written titles; nothing is created until a tap. */
export function splitDraft(ticket: string, children: SplitChild[]): Draft {
  const text = children.map((c, i) => `${i + 1}. ${c.title}, about ${c.est_loc} lines${c.depends_on.length > 0 ? `, after ${c.depends_on.join(", ")}` : ""}.`).join(" ");
  return { id: `${ticket}:split`, ticket, kind: "split", status: "waiting", text: postable(text, 6000), history: [], children };
}

export function needsInfoDraft(ticket: string, missing: string[]): Draft {
  return fresh(ticket, "needs_info", `Before this can be worked on, it needs: ${missing.join("; ")}.`);
}

export function notOursDraft(ticket: string, where: string | null): Draft {
  return fresh(ticket, "not_ours", `This does not look like ours. It looks like it belongs with ${where ?? "another team"}.`);
}

export function reminderDraft(ticket: string, missing: string[]): Draft {
  return fresh(ticket, "reminder", `Reminder: this is still waiting for: ${missing.length ? missing.join("; ") : "the details asked for above"}.`);
}

export function parkDraft(ticket: string): Draft {
  return fresh(ticket, "park", "Parking this: no answer after 10 days. Add the missing details and it is picked up again.");
}

/** The note for a ticket reassigned out of the team's scope: a draft, never posted by the machine. */
export function handoverDraft(ticket: string): Draft {
  return fresh(ticket, "handover", "This was reassigned away from us, so we are no longer assessing it. Everything we had on it stays on its card.");
}

export interface ReplyDeps {
  /** The one run of the `ticket_reply` agent pack on the ticket and its assessment as data. */
  write(context: TicketContext): Promise<{ reply: string; confidence: number }>;
}

/** The decline reply, written by the pack. Null when the pack failed or its text carried a token. */
export const ADDRESS_REFUSED = "the reply held an address, so it was not kept";
const ADDRESS = /(?:https?:\/\/|www\.)/i;

export async function declineDraft(deps: ReplyDeps, ticket: string, context: TicketContext, onRefused?: (why: string) => void): Promise<Draft | null> {
  try {
    const { reply } = await deps.write(context);
    if (carriesSecret(reply)) return null;
    // A pack-written text may carry an address the ticket asked for: a person would post it with one key. It is not kept.
    if (ADDRESS.test(reply)) {
      onRefused?.(ADDRESS_REFUSED);
      return null;
    }
    return fresh(ticket, "decline", reply);
  } catch (error) {
    console.warn(`ticket reply: the pack failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The person's text in place of the machine's, the machine's kept. Null when the new text carries a token. */
export function editDraft(draft: Draft, text: string, now: Date): Draft | null {
  if (carriesSecret(text)) return null;
  return { ...draft, status: "edited", text: postable(text), original: draft.original ?? draft.text, history: [...draft.history, { at: now.toISOString(), did: "edited", from: draft.text }] };
}

export function ignoreDraft(draft: Draft, now: Date): Draft {
  return { ...draft, status: "ignored", history: [...draft.history, { at: now.toISOString(), did: "ignored", from: draft.text }] };
}

export interface RecommendDeps {
  /** The one call of the `ticket_recommend` decision pack. */
  decide(context: TicketContext): Promise<{ action: { choice: string; confidence: number }; recordId?: string }>;
}

const DECISION_BAR = 0.7;
const CHOICES = new Set<string>(["do_now", "schedule", "decline", "needs_decision"]);

/** The rule's answer when it has one; else one typed decision, which a person overrules if it is unsure or fails. */
export async function recommendWithDecision(deps: RecommendDeps, score: TicketScoreResult, context: TicketContext): Promise<{ action: Recommendation; reason: string; recordId?: string }> {
  const ruled = recommend(score);
  if (ruled) return ruled;
  try {
    const { action, recordId } = await deps.decide(context);
    if (CHOICES.has(action.choice) && action.confidence >= DECISION_BAR) return { action: action.choice as Recommendation, reason: "the scores left it open: decided by the typed decision", ...(recordId ? { recordId } : {}) };
  } catch (error) {
    console.warn(`ticket recommend: the decision failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { action: "needs_decision", reason: "the scores left it open and the decision was not sure: a person decides" };
}
