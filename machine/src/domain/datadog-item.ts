// The Datadog inbox's domain: how each signal becomes an item with a stable fingerprint and a
// priority floor, which split an item sits in, the order triage takes them in, and how a fresh
// poll folds into a stored item (one that fires again after you cleared it reopens). Pure
// functions over the contract shapes; the inbox in application/ feeds them and persists the result.
import type { DatadogItem, DatadogPriority, DatadogSource, DatadogSplit } from "@hardness/contracts";

import { higher } from "./slack-item.ts";

// The raw shapes the Datadog port returns (application/datadog.ts), declared structurally here
// because the domain does not import from application/.
interface RawIncident {
  publicId: number;
  title: string;
  state: string;
  severity: string | null;
  customerImpacted: boolean;
  created: string;
  modified: string;
}

interface RawMonitorGroup {
  monitorId: number;
  monitorName: string;
  group: string;
  status: string;
  priority: number | null;
  lastTriggered: string | null;
}

interface RawIssue {
  id: string;
  errorType: string;
  errorMessage: string;
  service: string | null;
  env: string | null;
  state: string;
  isRegression: boolean;
  count: number;
  firstSeen: string;
  lastSeen: string;
  repositoryUrl: string | null;
}

interface RawCluster {
  service: string;
  errorKind: string;
  env: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: string[];
  repositoryUrl: string | null;
}

/** Builds a Datadog web-app link from a path. */
type WebUrl = (path: string) => string;

export const SOURCE_RANK: Record<DatadogSource, number> = { incident: 0, monitor: 1, error_tracking: 2, error_logs: 3 };

const EPOCH = new Date(0);

// Same pattern as `originSlug` in application/repo-map.ts (the domain cannot import it).
function githubSlug(url: string | null): string | null {
  if (!url) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The item before it has a split; the constructors below fill it in. */
type Fresh = Omit<DatadogItem, "split" | "triage" | "snoozedUntil" | "doneAt" | "reopenedAt" | "resolvedAt" | "taskId">;

function build(fresh: Fresh): DatadogItem {
  const item: DatadogItem = { ...fresh, triage: null, split: "investigate", snoozedUntil: null, doneAt: null, reopenedAt: null, resolvedAt: null, taskId: null };
  return { ...item, split: splitOf(item, EPOCH) };
}

export function fromIncident(raw: RawIncident, webUrl: WebUrl): DatadogItem {
  const severe = raw.severity !== null && /^SEV-[12]$/.test(raw.severity);
  return build({
    id: `inc:${raw.publicId}`,
    source: "incident",
    title: raw.title,
    service: null,
    env: null,
    status: raw.state,
    severity: raw.severity,
    count: null,
    firstSeen: raw.created,
    lastSeen: raw.modified,
    url: webUrl(`incidents/${raw.publicId}`),
    samples: [],
    repository: null,
    floor: severe || raw.customerImpacted ? "P0" : "P1",
  });
}

export function fromMonitor(raw: RawMonitorGroup, webUrl: WebUrl): DatadogItem {
  const at = raw.lastTriggered ?? new Date(0).toISOString();
  return build({
    id: `mon:${raw.monitorId}:${raw.group}`,
    source: "monitor",
    title: raw.group === "*" ? raw.monitorName : `${raw.monitorName} (${raw.group})`,
    service: /(?:^|,)service:([^,]+)/.exec(raw.group)?.[1] ?? null,
    env: /(?:^|,)env:([^,]+)/.exec(raw.group)?.[1] ?? null,
    status: raw.status,
    severity: raw.priority === null ? null : `P${raw.priority}`,
    count: null,
    firstSeen: at,
    lastSeen: at,
    url: webUrl(`monitors/${raw.monitorId}`),
    samples: [],
    repository: null,
    floor: raw.status === "Alert" ? "P1" : null,
  });
}

export function fromIssue(raw: RawIssue, webUrl: WebUrl): DatadogItem {
  return build({
    id: `et:${raw.id}`,
    source: "error_tracking",
    title: `${raw.errorType}: ${raw.errorMessage}`,
    service: raw.service,
    env: raw.env,
    status: raw.state,
    severity: null,
    count: raw.count,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    url: webUrl(`error-tracking/issue/${raw.id}`),
    samples: [raw.errorMessage.slice(0, 500)],
    repository: githubSlug(raw.repositoryUrl),
    floor: raw.isRegression ? "P1" : null,
  });
}

export function fromCluster(raw: RawCluster, webUrl: WebUrl): DatadogItem {
  const query = `status:error service:${raw.service} @error.kind:"${raw.errorKind}"`;
  return build({
    id: `log:${raw.service}:${raw.errorKind}`,
    source: "error_logs",
    title: `${raw.service}: ${raw.errorKind}`,
    service: raw.service,
    env: raw.env,
    status: "error",
    severity: null,
    count: raw.count,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    url: webUrl(`logs?query=${encodeURIComponent(query)}`),
    samples: raw.samples.slice(0, 3).map((line) => line.slice(0, 500)),
    repository: githubSlug(raw.repositoryUrl),
    floor: null,
  });
}

/** Incidents, then monitors, then Error Tracking, then logs; newest `lastSeen` first inside a source. */
export function triageOrder(items: DatadogItem[]): DatadogItem[] {
  return [...items].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.lastSeen.localeCompare(a.lastSeen));
}

/** The model's priority, never below the rule floor (P0 is highest). */
export function applyFloor(priority: DatadogPriority, floor: DatadogPriority | null): DatadogPriority {
  return higher(priority, floor) ?? priority;
}

const SPLIT_OF_PRIORITY: Record<DatadogPriority, DatadogSplit> = { P0: "act_now", P1: "investigate", P2: "watch", P3: "noise" };

/** Where the item sits for you: done and snoozed first, then its triaged priority, else its floor. */
export function splitOf(item: Pick<DatadogItem, "doneAt" | "snoozedUntil" | "triage" | "floor">, now: Date): DatadogSplit {
  if (item.doneAt) return "done";
  if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now.getTime()) return "snoozed";
  const priority = item.triage?.priority ?? item.floor;
  return priority ? SPLIT_OF_PRIORITY[priority] : "investigate";
}

/** Folds a fresh poll into the stored item: fresh facts win, your state and triage stay, a done item that fired again reopens. */
export function merge(stored: DatadogItem, fresh: DatadogItem, now: Date): DatadogItem {
  const reopen = stored.doneAt !== null && fresh.lastSeen > stored.doneAt;
  const next: DatadogItem = {
    ...fresh,
    triage: reopen ? null : stored.triage,
    snoozedUntil: stored.snoozedUntil,
    doneAt: reopen ? null : stored.doneAt,
    reopenedAt: reopen ? now.toISOString() : stored.reopenedAt,
    resolvedAt: null,
    taskId: stored.taskId,
  };
  return { ...next, split: splitOf(next, now) };
}
