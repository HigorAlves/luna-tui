// Postgres tables, declared with EntitySchema rather than decorators so they work the
// same under tsx, Vitest and tsc. Every column type is explicit. Row shapes live in
// ../domain/task.ts; this file only maps them onto Postgres.
import { EntitySchema } from "typeorm";

import type { ApprovalRow, ArtifactRow, EventRow, StageRunRow, TaskRow } from "../../domain/task.ts";
import type { SlackItemEntityRow, SlackTriageRunEntityRow, SlackWatchEntityRow } from "./slack-store.ts";

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
    route: { type: "text", default: "feature" },
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
    jira: { type: "jsonb", nullable: true },
    stateSince: { name: "state_since", type: "timestamptz", nullable: true },
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
    cases: { type: "jsonb", nullable: true },
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

export const SlackItemEntity = new EntitySchema<SlackItemEntityRow>({
  name: "SlackItem",
  tableName: "slack_items",
  columns: {
    id: { type: "text", primary: true },
    kind: { type: "text" },
    channel: { type: "jsonb" },
    author: { type: "jsonb" },
    text: { type: "text", default: "" },
    threadTs: { name: "thread_ts", type: "text", nullable: true },
    context: { type: "jsonb", default: () => "'[]'::jsonb" },
    permalink: { type: "text", default: "" },
    ts: { type: "timestamptz" },
    slackTs: { name: "slack_ts", type: "text" },
    matched: { type: "jsonb", default: () => "'[]'::jsonb" },
    count: { type: "integer", default: 1 },
    replies: { type: "integer", default: 0 },
    youReplied: { name: "you_replied", type: "boolean", default: false },
    seenAt: { name: "seen_at", type: "timestamptz", nullable: true },
    doneAt: { name: "done_at", type: "timestamptz", nullable: true },
    snoozedUntil: { name: "snoozed_until", type: "timestamptz", nullable: true },
    reopenedAt: { name: "reopened_at", type: "timestamptz", nullable: true },
    repliedAt: { name: "replied_at", type: "timestamptz", nullable: true },
    arrivedAt: { name: "arrived_at", type: "timestamptz" },
    triage: { type: "jsonb", nullable: true },
    linked: { type: "jsonb" },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  indices: [{ columns: ["doneAt"] }, { columns: ["arrivedAt"] }],
});

export const SlackWatchEntity = new EntitySchema<SlackWatchEntityRow>({
  name: "SlackWatch",
  tableName: "slack_watches",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    kind: { type: "text" },
    value: { type: "text" },
    label: { type: "text" },
    channels: { type: "jsonb", default: () => "'[]'::jsonb" },
    enabled: { type: "boolean", default: true },
    builtin: { type: "boolean", default: false },
    priority: { type: "text", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
  },
  uniques: [{ columns: ["kind", "value"] }],
});

/** One run of the slack_triage pack: what a batch cost, for the Floor. */
export const SlackTriageRunEntity = new EntitySchema<SlackTriageRunEntityRow>({
  name: "SlackTriageRun",
  tableName: "slack_triage_runs",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    startedAt: { name: "started_at", type: "timestamptz" },
    endedAt: { name: "ended_at", type: "timestamptz" },
    items: { type: "integer", default: 0 },
    model: { type: "text", default: "" },
    turns: { type: "integer", default: 0 },
    costUsd: { name: "cost_usd", type: "numeric", precision: 10, scale: 4, nullable: true },
    ok: { type: "boolean", default: false },
    error: { type: "text", nullable: true },
  },
  indices: [{ columns: ["startedAt"] }],
});

export const ENTITIES = [TaskEntity, StageRunEntity, EventEntity, ApprovalEntity, ArtifactEntity, SlackItemEntity, SlackWatchEntity, SlackTriageRunEntity];
