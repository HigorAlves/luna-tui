// Postgres tables, declared with EntitySchema rather than decorators so they work the
// same under tsx, Vitest and tsc. Every column type is explicit. Row shapes live in
// ../domain/task.ts; this file only maps them onto Postgres.
import { EntitySchema } from "typeorm";

import type { ApprovalRow, ArtifactRow, EventRow, StageRunRow, TaskRow } from "../../domain/task.ts";

const taskRelation = {
  type: "many-to-one",
  target: "Task",
  joinColumn: { name: "task_id" },
  onDelete: "CASCADE",
} as const;

export const TaskEntity = new EntitySchema<TaskRow>({
  name: "Task",
  tableName: "tasks",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    title: { type: "text" },
    description: { type: "text", default: "" },
    criteria: { type: "jsonb", default: () => "'[]'::jsonb" },
    repoPath: { name: "repo_path", type: "text", nullable: true },
    source: { type: "jsonb", nullable: true },
    kind: { type: "text", default: "feature" },
    branch: { type: "text", nullable: true },
    worktreePath: { name: "worktree_path", type: "text", nullable: true },
    state: { type: "text" },
    retries: { type: "jsonb" },
    resumeTo: { name: "resume_to", type: "text", nullable: true },
    reason: { type: "text", nullable: true },
    queued: { type: "boolean", default: false },
    queuedAt: { name: "queued_at", type: "timestamptz", nullable: true },
    diffAdded: { name: "diff_added", type: "integer", nullable: true },
    diffRemoved: { name: "diff_removed", type: "integer", nullable: true },
    testsPassed: { name: "tests_passed", type: "integer", nullable: true },
    testsTotal: { name: "tests_total", type: "integer", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  indices: [{ columns: ["queued"] }],
});

export const StageRunEntity = new EntitySchema<StageRunRow & { task?: TaskRow }>({
  name: "StageRun",
  tableName: "stage_runs",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    taskId: { name: "task_id", type: "uuid" },
    stage: { type: "text" },
    attempt: { type: "integer" },
    status: { type: "text" },
    outcome: { type: "text", nullable: true },
    costUsd: { name: "cost_usd", type: "numeric", nullable: true },
    turns: { type: "integer", nullable: true },
    containerId: { name: "container_id", type: "text", nullable: true },
    inputCommit: { name: "input_commit", type: "text", nullable: true },
    outputCommit: { name: "output_commit", type: "text", nullable: true },
    transcriptPath: { name: "transcript_path", type: "text", nullable: true },
    startedAt: { name: "started_at", type: "timestamptz" },
    endedAt: { name: "ended_at", type: "timestamptz", nullable: true },
  },
  relations: { task: taskRelation },
  indices: [{ columns: ["taskId"] }],
});

export const EventEntity = new EntitySchema<EventRow & { task?: TaskRow }>({
  name: "Event",
  tableName: "events",
  columns: {
    id: { type: "bigint", primary: true, generated: "increment" },
    taskId: { name: "task_id", type: "uuid" },
    stageRunId: { name: "stage_run_id", type: "uuid", nullable: true },
    kind: { type: "text" },
    payload: { type: "jsonb", default: () => "'{}'::jsonb" },
    at: { type: "timestamptz", createDate: true },
  },
  relations: { task: taskRelation },
  indices: [{ columns: ["taskId"] }],
});

export const ApprovalEntity = new EntitySchema<ApprovalRow & { task?: TaskRow }>({
  name: "Approval",
  tableName: "approvals",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    taskId: { name: "task_id", type: "uuid" },
    kind: { type: "text" },
    requested: { type: "jsonb", default: () => "'{}'::jsonb" },
    decision: { type: "text", nullable: true },
    reason: { type: "text", nullable: true },
    response: { type: "jsonb", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    decidedAt: { name: "decided_at", type: "timestamptz", nullable: true },
  },
  relations: { task: taskRelation },
  indices: [{ columns: ["taskId"] }],
});

export const ArtifactEntity = new EntitySchema<ArtifactRow & { task?: TaskRow; stageRun?: StageRunRow }>({
  name: "Artifact",
  tableName: "artifacts",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    stageRunId: { name: "stage_run_id", type: "uuid" },
    taskId: { name: "task_id", type: "uuid" },
    kind: { type: "text" },
    path: { type: "text" },
    label: { type: "text", default: "" },
    sha256: { type: "text", default: "" },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
  },
  relations: {
    task: taskRelation,
    stageRun: {
      type: "many-to-one",
      target: "StageRun",
      joinColumn: { name: "stage_run_id" },
      onDelete: "CASCADE",
    },
  },
  indices: [{ columns: ["taskId"] }],
});

export const ENTITIES = [TaskEntity, StageRunEntity, EventEntity, ApprovalEntity, ArtifactEntity];
