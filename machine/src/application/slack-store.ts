// The persistence port the Slack inbox depends on: items with their triage and your read
// state (they must survive a restart), the watches you save, and one row per triage run so
// the Floor can show what triage costs. Postgres implements it in
// adapters/persistence/slack-store.ts; the poller's tests use an in-memory one.
import type { SlackPriority, SlackTriageRun, SlackWatch, SlackWatchInput, SlackWatchPatch } from "@hardness/contracts";

import type { SlackItemRow } from "../domain/slack-item.ts";

/** What metrics need from one item. */
export interface SlackMetricRow {
  /** The message's time; the reply is measured from here. */
  ts: string;
  /** When the machine stored it; the window is cut here. */
  arrivedAt: string;
  repliedAt: string | null;
  priority: SlackPriority | null;
  expectsReply: boolean;
}

/** One slack_triage run as recorded; the store assigns the id. */
export type SlackTriageRunInput = Omit<SlackTriageRun, "id">;

export interface SlackStore {
  /** Every open item, plus the ones done after `doneSince`. */
  items(doneSince: Date): Promise<SlackItemRow[]>;
  item(id: string): Promise<SlackItemRow | null>;
  /** Inserts or replaces by id. */
  save(rows: SlackItemRow[]): Promise<void>;
  /** The latest Slack ts the store holds, for the first poll after a restart. */
  latestTs(): Promise<string | null>;
  metricRows(since: Date): Promise<SlackMetricRow[]>;

  watches(): Promise<SlackWatch[]>;
  addWatch(input: SlackWatchInput & { label: string; builtin?: boolean }): Promise<SlackWatch>;
  patchWatch(id: string, patch: SlackWatchPatch): Promise<SlackWatch | null>;
  deleteWatch(id: string): Promise<void>;

  recordTriageRun(run: SlackTriageRunInput): Promise<SlackTriageRun>;
  /** Runs started at or after `since`, newest first. */
  triageRuns(since: Date): Promise<SlackTriageRun[]>;
}
