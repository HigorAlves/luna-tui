// What `GET /packs` says about each pack: the registry's own fields, and the task states it runs
// in, as the stage runners in bootstrap/stages.ts use it. Pure.
import { PACKS, type Pack, type PackId, type PackInfo, type TaskState } from "@hardness/contracts";

/** Packs that do not run in the task state of their own name. */
const RUNS_IN: Partial<Record<PackId, TaskState[]>> = {
  // The retro runs after the push, inside the shipping stage; its proposal waits at reviewing_memory.
  reviewing_memory: ["shipping"],
  // The plan stage: the planner runs first, then test design, both in the test_design state.
  plan: ["test_design"],
  plan_fast: ["test_design"],
  // The plan stage opens with the code map, read from the repo's graph.
  code_map: ["test_design"],
  test_design_fast: ["test_design"],
  // Build's tests step runs inside the implementing stage, before the implementer.
  build_tests: ["implementing"],
  // The inboxes' packs and the decision pack callers run on demand: no task, so no task state.
  slack_triage: [],
  jira_intake: [],
  triage_signals: [],
  // Decisions on a plan context, run on demand by the plan stage.
  risk_score: [],
  coverage_check: [],
  plan_check: [],
  // Decisions on the Build stage's work, run on demand by the build watch.
  red_check: [],
  scope_check: [],
  // A decision on why Build escalated, run on demand by the pipeline.
  escalation_reason: [],
  // Decisions on Verify's work, run on demand by the verify and e2e stages.
  finding_classify: [],
  e2e_failure_cause: [],
  // A decision on the evidence context, run on demand by the evidence stage.
  evidence_format: [],
  // The video pipeline runs inside evidence, sub-run by sub-run; `evidence` stays first in PACKS so the state still picks it.
  video_script: ["evidence"],
  recording: ["evidence"],
  video_qa: ["evidence"],
  video_fix: ["evidence"],
  // Ship's decisions, run on demand by the ship monitor and the retro.
  event_class: [],
  comment_intent: [],
  fix_scope: [],
  evidence_valid: [],
  worth_learning: [],
  intake_dedup: [],
  ticket_validity: [],
  ticket_assess: [],
  conversation_assess: [],
  ticket_recommend: [],
  ticket_reply: [],
  // Drafts an answer inside the shipping stage's monitor; `reviewing_memory` stays first in PACKS so the state still picks it.
  pr_reply: ["shipping"],
  eval_judge: [],
  chat_triage: [],
};

/** The task states in which the pipeline runs the pack. */
export function packStates(id: PackId): TaskState[] {
  return RUNS_IN[id] ?? [id as TaskState];
}

/** The pack the pipeline runs in a task state, or null for a stage that runs none (delivering). */
export function packForState(state: TaskState): PackId | null {
  return (Object.keys(PACKS) as PackId[]).find((id) => packStates(id).includes(state)) ?? null;
}

export function packInfo(pack: Pack): PackInfo {
  return {
    id: pack.id,
    agent: pack.kind === "decision" ? null : pack.agent,
    kind: pack.kind,
    engines: pack.engines,
    effort: pack.kind === "decision" ? null : pack.effort,
    writable: pack.writable,
    maxTurns: pack.maxTurns,
    timeoutMs: pack.timeoutMs,
    states: packStates(pack.id),
  };
}
