// Reads the diagram's event names off the rows the machine already logs. One row per fact stays one
// row: `namesOf` derives the name(s) of a row from its kind and payload, so nothing is recorded twice.
// A fact that had no row gets one (kind `<diagram name>` or `stage.<diagram name>`), which names itself.
import { CARD_EVENT_NAMES, type CardEventName } from "@hardness/contracts";

/** Names the diagram has and the machine cannot produce yet, with the wave that will. */
export const PENDING_EVENTS: Readonly<Partial<Record<CardEventName, number>>> = {
  // `card.merged` is a card merged into another by dedup: nothing merges cards before wave 14.
  "card.merged": 14,
};

const KNOWN: ReadonlySet<string> = new Set(CARD_EVENT_NAMES);

/** The names a row a stage reported (`stage.<kind>`) may carry: only facts a stage knows. A stage never says a card was approved, merged, closed, rejected or archived. */
export const STAGE_REPORTS: ReadonlySet<string> = new Set(["pr.opened", "build.checkpoint", "ship.event", "ship.ready", "ship.approval_needed", "evidence.published", "verify.findings", "ci.status", "evidence.media_ready"]);

/** The stage whose run is the Build panel's. */
const BUILD = "implementing";

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The diagram name(s) of one logged event; empty for a row the diagram has no name for. */
export function namesOf(event: { kind: string; payload: Record<string, unknown> }): CardEventName[] {
  const { kind, payload } = event;
  const self = kind.startsWith("stage.") ? kind.slice("stage.".length) : kind;
  if (KNOWN.has(self) && (self === kind || STAGE_REPORTS.has(self))) return [self as CardEventName];

  switch (kind) {
    case "task.created":
      return ["card.created"];
    case "task.shipped":
      return ["ship.merged"];
    case "task.closed":
      return ["card.closed"];
    case "stage.pr.opened":
      return ["pr.opened"];
    case "stage.started":
      return payload.stage === BUILD ? ["build.started"] : payload.stage === "verifying" ? ["verify.started"] : payload.stage === "evidence" ? ["evidence.started"] : [];
    case "stage.finished":
      return finished(payload);
    case "transition":
      return transition(payload);
    default:
      return [];
  }
}

function finished(payload: Record<string, unknown>): CardEventName[] {
  const stage = str(payload.stage);
  const passed = payload.status === "passed";
  const ran = passed || payload.status === "failed";
  switch (stage) {
    case "triage":
      return passed ? ["card.triaged"] : [];
    // The plan stage runs in the `test_design` state and designs the scenarios in the same run.
    case "test_design":
      return passed ? (Array.isArray(objectOf(payload.detail)?.cases) ? ["card.planned", "card.tests_designed"] : ["card.planned"]) : [];
    case BUILD:
      return passed ? ["build.done"] : [];
    case "e2e":
      return ran ? ["verify.e2e_done"] : [];
    case "ci_watch":
      return passed ? ["verify.done"] : [];
    default:
      return [];
  }
}

const objectOf = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function transition(payload: Record<string, unknown>): CardEventName[] {
  const from = str(payload.from);
  const to = str(payload.to);
  const names: CardEventName[] = [];
  if (to === "awaiting_setup") names.push("card.setup_needed");
  if (from === "awaiting_setup" && payload.event === "approved") names.push("card.setup_done");
  if (to === "awaiting_answers") names.push("card.answers_needed");
  if (from === "awaiting_answers" && payload.event === "answered") names.push("card.answered");
  if (to === "awaiting_approval") names.push("card.approval_needed");
  if (from === "awaiting_approval" && payload.event === "approved") names.push("card.approved");
  if (to === "paused_rate_limit" && from === BUILD) names.push("build.paused");
  if (to === "escalated" && from === BUILD) names.push("build.escalated");
  if (to === "escalated" && payload.escalation === "head_moved" && from !== BUILD) names.push("evidence.stale");
  if (to === "archived") {
    names.push("card.archived");
    if (payload.archiveReason === "rejected") names.push("card.rejected");
  }
  return names;
}
