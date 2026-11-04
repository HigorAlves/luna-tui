// The context-only packs: those that run in no task state (packStates), so a client may run one
// on data it sends (`POST /runs`). Each reads one key of the stage input's context, with that
// key's schema. A context-only pack that is not for clients is on NOT_ON_DEMAND instead. Pure.
import { ChatTriageContext, CheckContext, IssueContext, JiraIntakeContext, type PackId, PlanContext, SlackTriageContext } from "@hardness/contracts";
import { z } from "zod";

import { packStates } from "./packs.ts";

export const CONTEXT_OF = {
  slack_triage: { key: "slack", schema: SlackTriageContext },
  jira_intake: { key: "jira", schema: JiraIntakeContext },
  triage_signals: { key: "issue", schema: IssueContext },
  chat_triage: { key: "chat", schema: ChatTriageContext },
  risk_score: { key: "plan", schema: PlanContext },
  coverage_check: { key: "plan", schema: PlanContext },
  plan_check: { key: "plan", schema: PlanContext },
  red_check: { key: "check", schema: CheckContext },
  scope_check: { key: "check", schema: CheckContext },
  finding_classify: { key: "check", schema: CheckContext },
  e2e_failure_cause: { key: "check", schema: CheckContext },
} as const;

export type ContextPackId = keyof typeof CONTEXT_OF;

/** Context-only packs `POST /runs` never runs: eval_judge grades eval cases for the evals runner only. */
export const NOT_ON_DEMAND: readonly PackId[] = ["eval_judge"];

/** What a context-only pack reads: its one key of the stage input's context. */
export type PackContext =
  | { slack: SlackTriageContext }
  | { jira: JiraIntakeContext }
  | { issue: IssueContext }
  | { chat: ChatTriageContext }
  | { plan: PlanContext }
  | { check: CheckContext };

/** Whether a client may run the pack on data it sends: it runs in no task state, has a context a
 *  client can send, and is not on the deny list. */
export function isContextPack(id: PackId): id is ContextPackId {
  return packStates(id).length === 0 && !NOT_ON_DEMAND.includes(id) && id in CONTEXT_OF;
}

/** The context a client sends for `pack`: an object with the pack's key and nothing else. */
export function contextSchema(pack: ContextPackId): z.ZodType<PackContext> {
  const { key, schema } = CONTEXT_OF[pack];
  return z.strictObject({ [key]: schema }) as unknown as z.ZodType<PackContext>;
}
