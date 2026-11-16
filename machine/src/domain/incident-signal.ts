// One shape for "something may be an incident", whichever tool saw it. The mappers read only a port's typed
// fields, never a payload or a stack trace, and the summary stays short: it is what a model is shown later.

import type { DdIncident, DdMonitorGroup } from "../application/datadog.ts";
import type { SentryIssue } from "../application/sentry.ts";

export type IncidentSource = "datadog" | "sentry" | "slack" | "jira";
export type IncidentSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface IncidentSignal {
  source: IncidentSource;
  /** Source-prefixed and stable: the same incident or issue gives the same id on every poll. */
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: "open" | "resolved";
  startedAt: string;
  updatedAt: string;
  url: string | null;
  service: string | null;
  /** At most `SUMMARY_MAX` characters, on one line. */
  summary: string;
}

export const SUMMARY_MAX = 500;
export const TITLE_MAX = 200;

/** One line, whitespace collapsed, cut at `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const DATADOG_INCIDENT_SEVERITY: Record<string, IncidentSeverity> = { "SEV-1": "critical", "SEV-2": "high", "SEV-3": "medium", "SEV-4": "low", "SEV-5": "low" };
const DATADOG_RESOLVED = new Set(["resolved", "completed"]);

/** `webUrl` is the port's `webUrl`: where a path on the Datadog web app points. */
export function fromDatadogIncident(incident: DdIncident, webUrl: (path: string) => string): IncidentSignal {
  const severity = (incident.severity ?? "").toUpperCase();
  const state = incident.state.toLowerCase();
  return {
    source: "datadog",
    id: `datadog:incident:${incident.publicId}`,
    title: clip(incident.title, TITLE_MAX),
    severity: DATADOG_INCIDENT_SEVERITY[severity] ?? "unknown",
    status: DATADOG_RESOLVED.has(state) ? "resolved" : "open",
    startedAt: incident.created,
    updatedAt: incident.modified,
    url: webUrl(`incidents/${incident.publicId}`),
    service: null,
    summary: clip(`Datadog incident ${severity === "" ? "without severity" : severity}, ${state}${incident.customerImpacted ? ", customers impacted" : ""}.`, SUMMARY_MAX),
  };
}

const MONITOR_BY_STATUS: Record<string, IncidentSeverity> = { alert: "high", warn: "medium", "no data": "low" };
const MONITOR_BY_PRIORITY: Record<number, IncidentSeverity> = { 1: "critical", 2: "high", 3: "medium", 4: "low", 5: "low" };

/** A monitor group is an incident signal while it is not OK. `observedAt` stands in when Datadog gives no trigger time. */
export function fromDatadogMonitor(group: DdMonitorGroup, context: { webUrl: (path: string) => string; observedAt: string }): IncidentSignal {
  const status = group.status.toLowerCase();
  const scoped = group.group !== "*";
  const service = /(?:^|,)service:([^,]+)/.exec(group.group)?.[1] ?? null;
  const monitored = status in MONITOR_BY_STATUS;
  return {
    source: "datadog",
    id: `datadog:monitor:${group.monitorId}:${group.group}`,
    title: clip(scoped ? `${group.monitorName} (${group.group})` : group.monitorName, TITLE_MAX),
    // A priority the owner set outranks the status, but only while the monitor is not recovered.
    severity: monitored ? MONITOR_BY_PRIORITY[group.priority ?? 0] ?? MONITOR_BY_STATUS[status]! : "unknown",
    status: monitored ? "open" : "resolved",
    startedAt: group.lastTriggered ?? context.observedAt,
    updatedAt: context.observedAt,
    url: context.webUrl(`monitors/${group.monitorId}`),
    service,
    summary: clip(`Datadog monitor in ${group.status}${scoped ? ` for ${group.group}` : ""}.`, SUMMARY_MAX),
  };
}

const SENTRY_LEVEL: Record<string, IncidentSeverity> = { fatal: "critical", error: "high", warning: "medium", info: "low", debug: "low" };

export function fromSentryIssue(issue: SentryIssue): IncidentSignal {
  const where = issue.culprit === "" ? "" : ` in ${issue.culprit}`;
  return {
    source: "sentry",
    id: `sentry:${issue.id}`,
    title: clip(issue.title, TITLE_MAX),
    severity: SENTRY_LEVEL[issue.level.toLowerCase()] ?? "unknown",
    status: issue.status === "unresolved" ? "open" : "resolved",
    startedAt: issue.firstSeen,
    updatedAt: issue.lastSeen,
    url: issue.permalink,
    service: issue.project,
    summary: clip(`Sentry ${issue.shortId}${where}: ${plural(issue.count, "event")}, ${plural(issue.userCount, "user")}.`, SUMMARY_MAX),
  };
}
