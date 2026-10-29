// The Datadog inbox: incidents, alerting monitors, Error Tracking issues and clustered error
// logs, as the machine polls, fingerprints and triages them and the board's `O` view shows them.
// The machine classifies; the board only reads `split` and `triage`.
import { z } from "zod";

import { SlackPriority } from "./slack.ts";

/** Where a signal came from; also the order triage takes them in (incidents first). */
export const DatadogSource = z.enum(["incident", "monitor", "error_tracking", "error_logs"]);
export type DatadogSource = z.infer<typeof DatadogSource>;

export const DatadogPriority = SlackPriority;
export type DatadogPriority = SlackPriority;

export const DatadogCategory = z.enum(["outage", "degradation", "regression", "new_error", "recurring_error", "noise", "known"]);
export type DatadogCategory = z.infer<typeof DatadogCategory>;

/** One split per item, picked by the machine's `splitOf`. */
export const DatadogSplit = z.enum(["act_now", "investigate", "watch", "noise", "snoozed", "done"]);
export type DatadogSplit = z.infer<typeof DatadogSplit>;

export interface DatadogTriage {
  priority: DatadogPriority;
  category: DatadogCategory;
  /** At most 90 characters: what is wrong and where. */
  summary: string;
  why: string;
  suspectedCause: string | null;
  /** The first thing to do or look at. */
  nextStep: string;
  refs: { kind: "deploy" | "trace" | "pr" | "jira" | "url"; ref: string }[];
  /** `rule` when a floor settled it without the model. */
  by: "model" | "rule";
  triagedAt: string;
  /** You moved the priority by hand. */
  overridden: boolean;
}

export interface DatadogItem {
  /** The fingerprint: `inc:<public_id>`, `mon:<monitor>:<group>`, `et:<issue>`, `log:<service>:<kind>`. */
  id: string;
  source: DatadogSource;
  title: string;
  service: string | null;
  env: string | null;
  /** The source's own state: `active`, `Alert`, `OPEN`, `error`. */
  status: string;
  /** `SEV-1`…, a monitor's priority `P1`…, or null. */
  severity: string | null;
  /** Error logs in the window, or the issue's count; null for incidents and monitors. */
  count: number | null;
  firstSeen: string;
  lastSeen: string;
  url: string;
  /** Up to three lines, each at most 500 characters. */
  samples: string[];
  /** `owner/name` from `git.repository_url` when Datadog has it. */
  repository: string | null;
  /** The lowest priority triage may give it; set by rules. */
  floor: DatadogPriority | null;
  triage: DatadogTriage | null;
  split: DatadogSplit;
  snoozedUntil: string | null;
  doneAt: string | null;
  /** Set when it came back after done. */
  reopenedAt: string | null;
  /** Datadog no longer reports it: an incident resolved or a monitor recovered; it stays until you clear it. */
  resolvedAt: string | null;
  taskId: string | null;
}

/** Each source's last poll. */
export interface DatadogSourceState {
  ok: boolean;
  error: string | null;
  count: number;
}

/** The `datadog.items` bus event and `GET /datadog/items`. */
export interface DatadogSnapshot {
  items: DatadogItem[];
  polledAt: string | null;
  sources: Record<DatadogSource, DatadogSourceState>;
  /** A triage batch is running. */
  triaging: boolean;
  /** `no_token` when the keys are unset, else the last poll's failure, else null. */
  error: string | null;
}

export const DatadogItemPatch = z.object({
  done: z.boolean().optional(),
  snoozedUntil: z.string().nullable().optional(),
  priority: DatadogPriority.optional(),
});
export type DatadogItemPatch = z.infer<typeof DatadogItemPatch>;

export const DatadogTaskInput = z.object({
  title: z.string().min(1).optional(),
  repoPath: z.string().nullable().optional(),
});
export type DatadogTaskInput = z.infer<typeof DatadogTaskInput>;

/** One run of the `datadog_triage` pack. */
export interface DatadogTriageRun {
  id: string;
  startedAt: string;
  endedAt: string;
  items: number;
  model: string;
  turns: number;
  costUsd: number | null;
  ok: boolean;
  error: string | null;
}
