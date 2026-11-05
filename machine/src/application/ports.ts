import type {
  ArtifactKind,
  EngineId,
  Finding,
  NeedsInputItem,
  RequestedAction,
  RunInfo,
  TaskState,
} from "@hardness/contracts";

import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import type { StageOutcome } from "../domain/transition.ts";

/** The rows a running stage may log through `emit`: the diagram's names for facts only it knows. Never a kind other code acts on (`transition`, `task.reply`...). */
export const EMITTABLE = ["ship.event", "ship.ready", "ship.approval_needed", "evidence.published"] as const;
export type EmittableKind = (typeof EMITTABLE)[number];

export interface StageContext {
  task: TaskRow;
  stage: TaskState;
  /** 1 for the first run of this stage on this task. */
  attempt: number;
  /** The stage run's id, used for its container name and run folder. */
  runId: string;
  /** Everything decided on this task so far, oldest first: answers, approvals, guidance. */
  approvals: ApprovalRow[];
  /** Findings from the latest verifying run, fed to the next implementing attempt. */
  priorFindings?: Finding[];
  /** Aborted when you abort the task; the runner should stop its container. */
  signal: AbortSignal;
  /** Set after a restart found the stage's container still running: wait on it, do not start another. `engine` is the one it started on. */
  resume?: { container: string; inputCommit: string | null; engine?: EngineId | null };
  /** The engine to run on over the usual pick: the next of the pack's fallbacks after a usage limit. */
  engine?: EngineId;
  /** Tells the machine the container's name, the commit it started from and the engine it runs on, as soon as they are known. */
  started?: (facts: { container: string; inputCommit: string | null; engine?: EngineId }) => Promise<void>;
  /** Puts a line on the task's activity while the stage runs (`stage.note`): a wait, a fallback, anything the run should say before it ends. */
  note?: (text: string) => Promise<void>;
  /** Logs a row the v2.2 diagram names (`ship.ready`, `ship.event`...) while the stage runs; the payload is ids, counts and enum values only. */
  emit?: (kind: EmittableKind, payload: Record<string, unknown>) => Promise<void>;
  /** What the stage container needs in its environment to continue this run's trace (the
   *  telemetry's `childEnv()`); empty when nothing is traced. The pack runner passes it as the
   *  sandbox's `extraEnv`. */
  traceEnv?: Record<string, string>;
}

export interface StageResult {
  outcome: StageOutcome;
  /** The run hit a usage limit; the task pauses instead of failing. */
  rateLimited?: boolean;
  /** Stage output worth keeping: triage's brief or questions, a summary, an error. */
  detail?: Record<string, unknown>;
  /** The task's branch and worktree, recorded by the first stage that creates them. */
  workspace?: { branch: string; worktreePath: string };
  /** Events the pack logged, stored as `stage.<kind>` on the run. */
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
    /** What the run's result.json named it ran on, and its fingerprint. */
    info?: RunInfo;
  };
}

/** Lets someone follow a task's running stage container live. */
export interface Watcher {
  follow(taskId: string, label: string, cwd: string, container: string): Promise<void>;
  /** The task needs no watching anymore. */
  close(taskId: string): Promise<void>;
}

/** Runs one stage for one task. */
export type StageRunner = (context: StageContext) => Promise<StageResult>;
