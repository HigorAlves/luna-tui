// What `GET /packs` says about each pack: the registry's own fields, and the task states it runs
// in, as the stage runners in bootstrap/stages.ts use it. Pure.
import { PACKS, type Pack, type PackId, type PackInfo, type TaskState } from "@hardness/contracts";

/** Packs that do not run in the task state of their own name. */
const RUNS_IN: Partial<Record<PackId, TaskState[]>> = {
  // The retro runs after the push, inside the shipping stage; its proposal waits at reviewing_memory.
  reviewing_memory: ["shipping"],
  // The inboxes' packs and the decision pack callers run on demand: no task, so no task state.
  slack_triage: [],
  jira_intake: [],
  issue_classify: [],
  eval_judge: [],
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
