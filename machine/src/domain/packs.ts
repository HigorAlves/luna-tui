// What `GET /packs` says about each pack: the registry's own fields, and the task states it runs
// in, as the stage runners in bootstrap/stages.ts use it. Pure.
import type { Pack, PackId, PackInfo, TaskState } from "@hardness/contracts";

/** Packs that do not run in the task state of their own name. */
const RUNS_IN: Partial<Record<PackId, TaskState[]>> = {
  // The retro runs after the push, inside the shipping stage; its proposal waits at reviewing_memory.
  reviewing_memory: ["shipping"],
  // The inboxes' packs: no task, so no task state.
  slack_triage: [],
  jira_intake: [],
};

/** The task states in which the pipeline runs the pack. */
export function packStates(id: PackId): TaskState[] {
  return RUNS_IN[id] ?? [id as TaskState];
}

export function packInfo(pack: Pack): PackInfo {
  return {
    id: pack.id,
    agent: pack.agent,
    kind: pack.agent === null ? "script" : "agent",
    engines: pack.engines,
    effort: pack.effort,
    writable: pack.writable,
    maxTurns: pack.maxTurns,
    timeoutMs: pack.timeoutMs,
    states: packStates(pack.id),
  };
}
