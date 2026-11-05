// The event names of the v2.2 diagram, by panel. A name is a way of reading a fact the machine already
// logs (machine/src/domain/card-events.ts `namesOf`); it is not a second row for it. Payloads carry ids,
// shas, counts and enum values, never free text from a reviewer, a model or a ticket.
import { z } from "zod";

export const CARD_EVENT_PANELS = {
  intake: ["card.created", "card.merged", "card.setup_needed", "card.setup_done"],
  triage: ["card.triaged", "card.answers_needed", "card.answered", "card.archived", "card.fast_lane"],
  plan: ["card.planned", "card.tests_designed", "card.approval_needed", "card.approved", "card.rejected"],
  build: ["build.started", "build.checkpoint", "build.paused", "build.escalated", "build.done"],
  verify: ["verify.started", "verify.findings", "verify.e2e_done", "pr.opened", "ci.status", "verify.done"],
  evidence: ["evidence.started", "evidence.media_ready", "evidence.published", "evidence.stale"],
  ship: ["ship.event", "ship.ready", "ship.approval_needed", "ship.merged", "card.closed", "card.learned"],
} as const;

export const CARD_EVENT_NAMES = Object.values(CARD_EVENT_PANELS).flat();

export const CardEventName = z.enum(CARD_EVENT_NAMES as [(typeof CARD_EVENT_NAMES)[number], ...(typeof CARD_EVENT_NAMES)[number][]]);
export type CardEventName = z.infer<typeof CardEventName>;
