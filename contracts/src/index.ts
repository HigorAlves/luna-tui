// Types shared by the machine and the board. HTTP and SSE shapes are in ./api.ts.
import { z } from "zod";

export * from "./api.ts";
export * from "./stage.ts";

/** Board columns, named after the harness stages. Same order as the Rust board. */
export const COLUMNS = [
  "Backlog",
  "Intake",
  "Triage",
  "Approved",
  "Build",
  "Verify",
  "Evidence",
  "Ship",
  "Done",
] as const;
export type Column = (typeof COLUMNS)[number];

/** Every state a task can be in, from the stage graph in docs/plans/0001-machine-dev.md. */
export const TaskState = z.enum([
  "backlog",
  "draft",
  "triage",
  "awaiting_answers",
  "awaiting_approval",
  "test_design",
  "awaiting_test_check",
  "implementing",
  "escalated",
  "paused_rate_limit",
  "verifying",
  "e2e",
  "delivering",
  "ci_watch",
  "evidence",
  "awaiting_ship",
  "shipping",
  "reviewing_memory",
  "closed",
]);
export type TaskState = z.infer<typeof TaskState>;

/** The board column each task state is shown in. */
export const COLUMN_OF: Record<TaskState, Column> = {
  backlog: "Backlog",
  draft: "Intake",
  triage: "Triage",
  awaiting_answers: "Triage",
  awaiting_approval: "Triage",
  test_design: "Approved",
  awaiting_test_check: "Approved",
  implementing: "Build",
  escalated: "Build",
  paused_rate_limit: "Build",
  verifying: "Verify",
  e2e: "Verify",
  delivering: "Verify",
  ci_watch: "Verify",
  evidence: "Evidence",
  awaiting_ship: "Ship",
  shipping: "Ship",
  reviewing_memory: "Ship",
  closed: "Done",
};

/** States where an agent or script is running a stage. */
export const RUNNING: ReadonlySet<TaskState> = new Set([
  "triage",
  "test_design",
  "implementing",
  "verifying",
  "e2e",
  "delivering",
  "ci_watch",
  "evidence",
  "shipping",
]);

/** States where the pipeline waits for the user. The board shows these as "needs you". */
export const WAITING_ON_USER: ReadonlySet<TaskState> = new Set([
  "awaiting_answers",
  "awaiting_approval",
  "awaiting_test_check",
  "awaiting_ship",
  "reviewing_memory",
  "escalated",
]);
