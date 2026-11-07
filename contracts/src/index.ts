// Types shared by the machine and the board. HTTP and SSE shapes are in ./api.ts.
import { z } from "zod";

export * from "./api.ts";
export * from "./stage.ts";
export * from "./memory.ts";
export * from "./coverage.ts";
export * from "./plan-check.ts";
export * from "./plan.ts";
export * from "./split.ts";
export * from "./size.ts";
export * from "./entry-contract.ts";
export * from "./card.ts";
export * from "./backlog.ts";
export * from "./ticket.ts";
export * from "./context-complete.ts";
export * from "./finding.ts";
export * from "./reports.ts";
export * from "./card-events.ts";
export * from "./scoring.ts";
export * from "./config-v22.ts";
export * from "./egress.ts";
export * from "./events.ts";
export * from "./packs.ts";
export * from "./models.ts";
export * from "./engines.ts";
export * from "./access.ts";
export * from "./questions.ts";
export * from "./decisions.ts";
export { DECISION_ALLOWED, DECISION_DEFAULTS, DecisionDefault, DecisionDefaults, decisionEngines } from "./decision-defaults.ts";
export * from "./github.ts";
export * from "./conversation.ts";
export * from "./slack.ts";
export * from "./jira.ts";

/** Board columns: the diagram's seven stages, then Done. Same order as the Rust board, which reads the column of each task from `COLUMN_OF` through the API. */
export const COLUMNS = [
  "Intake",
  "Triage",
  "Plan",
  "Build",
  "Verify",
  "Evidence",
  "Ship",
  "Done",
] as const;
export type Column = (typeof COLUMNS)[number];

/** Every state a task can be in, from the stage graph in docs/architecture.md. */
export const TaskState = z.enum([
  "draft",
  "setup",
  "awaiting_setup",
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
  // Ended without shipping or closing: a duplicate, an SLA that ran out, a ticket not for an agent.
  "archived",
  // PR tasks: a code review of someone's PR, and addressing the review threads on yours.
  "reviewing",
  "addressing",
]);
export type TaskState = z.infer<typeof TaskState>;

/** The board column each task state is shown in: the one table; the board and the docs follow it. PR-task states keep their place. */
export const COLUMN_OF: Record<TaskState, Column> = {
  draft: "Intake",
  setup: "Intake",
  awaiting_setup: "Intake",
  triage: "Triage",
  awaiting_answers: "Triage",
  awaiting_approval: "Plan",
  test_design: "Plan",
  awaiting_test_check: "Plan",
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
  archived: "Done",
  reviewing: "Verify",
  addressing: "Build",
};

/** States a task ends in: nothing moves it again. */
export const TERMINAL: ReadonlySet<TaskState> = new Set(["closed", "archived"]);
export const isTerminal = (state: TaskState): boolean => TERMINAL.has(state);

/** States where an agent or script is running a stage. */
export const RUNNING: ReadonlySet<TaskState> = new Set([
  "setup",
  "triage",
  "test_design",
  "implementing",
  "verifying",
  "e2e",
  "delivering",
  "ci_watch",
  "evidence",
  "shipping",
  "reviewing",
  "addressing",
]);

/** States where the pipeline waits for the user. The board shows these as "needs you". */
export const WAITING_ON_USER: ReadonlySet<TaskState> = new Set([
  "awaiting_setup",
  "awaiting_answers",
  "awaiting_approval",
  "awaiting_test_check",
  "awaiting_ship",
  "reviewing_memory",
  "escalated",
]);

/** States where a stage can run and, at another moment, a gate can be open: an open approval decides which it is. */
export const RUN_OR_GATE: ReadonlySet<TaskState> = new Set(["awaiting_ship", "reviewing_memory"]);

/** Whether a card in `state` waits on a person: a `RUN_OR_GATE` state only with an open gate. */
export const waitsOnPerson = (state: TaskState, gateOpen: boolean): boolean => (RUN_OR_GATE.has(state) ? gateOpen : WAITING_ON_USER.has(state));
