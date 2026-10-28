// Jira in the workflow: a task carries at most one issue; the repo's luna.yaml says which Jira
// status each task state moves it to. The machine syncs; the board shows the link and the SLA.
import { z } from "zod";

import type { TaskState } from "./index.ts";

/** The linked issue as the machine last saw it (JiraWatch refreshes it every few minutes). */
export interface JiraLink {
  key: string;
  url: string;
  issueType: string | null;
  status: string | null;
  priority: string | null;
  dueAt: string | null;
  syncedAt: string | null;
  /** The last declared transition that Jira refused, until the next one succeeds. */
  blocked: { wanted: string; current: string | null; why: string; at: string } | null;
}

/** One SLA clock: when it is due and whether it has passed. */
export interface SlaClock {
  dueAt: string;
  overdue: boolean;
  /** Seconds the clock allows, as configured. */
  targetSecs: number;
}

/** The ticket's clocks. Each is null while its condition does not hold (no gate open, no stage running). */
export interface TaskSla {
  /** Waiting on you at a gate or escalated; `since` is when the wait began. */
  gate: (SlaClock & { since: string; state: TaskState }) | null;
  /** A stage running longer than its target; `warn` is true from 80% of the target. */
  stage: (SlaClock & { stage: TaskState; warn: boolean }) | null;
  /** Created to closed. */
  cycle: SlaClock | null;
  /** The Jira issue's own due date, when linked and set. */
  jiraDue: SlaClock | null;
}

/** `POST /tasks/:id/jira`: link an existing issue. */
export const JiraLinkInput = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, "a Jira key like PLAT-123") });
export type JiraLinkInput = z.infer<typeof JiraLinkInput>;

/** `POST /tasks/:id/jira/create`: an issue from the ticket, in the repo's project (or `project`). */
export const JiraCreateInput = z.object({
  project: z.string().min(1).optional(),
  issueType: z.string().min(1).optional(),
});
export type JiraCreateInput = z.infer<typeof JiraCreateInput>;

/** `GET /jira/search?q=`: a key or free text; your open issues first. */
export interface JiraIssueHit {
  key: string;
  summary: string;
  status: string | null;
  issueType: string | null;
  url: string;
}

/** `GET /jira/status`: whether Jira is configured and reachable. */
export interface JiraStatus {
  configured: boolean;
  site: string | null;
  /** The token's expiry when Jira reports it; the machine warns 14 days before. */
  tokenExpiresAt: string | null;
  error: string | null;
}
