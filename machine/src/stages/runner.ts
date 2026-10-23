import type {
  ArtifactKind,
  Finding,
  NeedsInputItem,
  RequestedAction,
  TaskState,
} from "@hardness/contracts";

import type { ApprovalRow, TaskRow } from "../db/entities.ts";
import type { StageOutcome } from "../engine/transition.ts";

export interface StageContext {
  task: TaskRow;
  stage: TaskState;
  /** 1 for the first run of this stage on this task. */
  attempt: number;
  /** The stage run's id, used for its container name and run folder. */
  runId: string;
  /** Everything decided on this task so far, oldest first: answers, approvals, guidance. */
  approvals: ApprovalRow[];
  /** Aborted when you abort the task; the runner should stop its container. */
  signal: AbortSignal;
}

export interface StageResult {
  outcome: StageOutcome;
  /** The run hit a usage limit; the task pauses instead of failing. */
  rateLimited?: boolean;
  /** Stage output worth keeping: triage's brief or questions, a summary, an error. */
  detail?: Record<string, unknown>;
  /** The task's branch and worktree, recorded by the first stage that creates them. */
  workspace?: { branch: string; worktreePath: string };
  /** Events the pack logged, stored as `orc.<kind>` on the run. */
  events?: Array<{ at: string; kind: string; payload: Record<string, unknown> }>;
  /** Files the pack produced, already copied; `path` is absolute on the host. */
  artifacts?: Array<{ kind: ArtifactKind; path: string; label: string; sha256: string }>;
  usage?: { turns: number | null; costUsd: number | null };
  /** Questions for the gate; shown as the approval's `questions`. */
  needsInput?: NeedsInputItem[];
  /** Outward actions awaiting approval; shown as the approval's `actions`. */
  requested?: RequestedAction[];
  findings?: Finding[];
  /** Facts stored on this run's `stage_runs` row. */
  run?: {
    containerId?: string;
    transcriptPath?: string;
    inputCommit?: string;
    outputCommit?: string;
  };
}

/** Runs one stage for one task. */
export type StageRunner = (context: StageContext) => Promise<StageResult>;
