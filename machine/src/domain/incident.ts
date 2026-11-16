// An incident and the breach clock (RFC 0008, wave 5). Pure: signals fold into incidents by rule, and the notification
// deadlines of a breach come from the time the company became aware of it. Nothing here reads a payload or a person.

import type { IncidentBreach } from "./breach.ts";
import type { IncidentSeverity, IncidentSignal } from "./incident-signal.ts";

export interface TimelineEntry {
  at: string;
  source: string;
  /** At most `TIMELINE_TEXT_MAX` characters, on one line. */
  text: string;
}

export interface Incident {
  /** The id of the signal that started it. */
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: "open" | "resolved";
  startedAt: string;
  resolvedAt: string | null;
  service: string | null;
  signals: IncidentSignal[];
  timeline: TimelineEntry[];
  /** The breach assessment, once made (when the incident starts, and again when it resolves). */
  breach?: IncidentBreach;
}

export const TIMELINE_TEXT_MAX = 300;
const TIMELINE_MAX = 100;
const ATTACH_WINDOW_MS = 2 * 3_600_000;
const QUIET_RESOLVE_MS = 6 * 3_600_000;

const RANK: Record<IncidentSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };
const loud = (severity: IncidentSeverity) => severity === "critical" || severity === "high";
/** A Datadog incident, a Jira incident and a Slack declaration are incidents on their own; Sentry issues and monitors are not. */
const declares = (signal: IncidentSignal) => signal.source === "slack" || signal.source === "jira" || (signal.source === "datadog" && signal.id.startsWith("datadog:incident:"));
/** The sources whose own state ends the incident: a Slack message has no state. */
const stateful = (signal: IncidentSignal) => signal.source === "datadog" || signal.source === "jira";

const entry = (at: string, source: string, text: string): TimelineEntry => {
  const line = text.replace(/\s+/g, " ").trim();
  return { at, source, text: line.length <= TIMELINE_TEXT_MAX ? line : `${line.slice(0, TIMELINE_TEXT_MAX - 1).trimEnd()}…` };
};

const start = (signal: IncidentSignal): Incident => ({
  id: signal.id,
  title: signal.title,
  severity: signal.severity,
  status: "open",
  startedAt: signal.startedAt,
  resolvedAt: null,
  service: signal.service,
  signals: [signal],
  timeline: [entry(signal.startedAt, signal.source, `${signal.source} signal: ${signal.title}`)],
});

/** `incident` with `signal` in it: added (with a timeline line) or replaced in place (a line when it resolves). */
function absorb(incident: Incident, signal: IncidentSignal): Incident {
  const at = incident.signals.findIndex((s) => s.id === signal.id);
  const signals = at < 0 ? [...incident.signals, signal] : incident.signals.map((s, i) => (i === at ? signal : s));
  const timeline = [...incident.timeline];
  if (at < 0) timeline.push(entry(signal.startedAt, signal.source, `${signal.source} signal: ${signal.title}`));
  else if (incident.signals[at]!.status === "open" && signal.status === "resolved") timeline.push(entry(signal.updatedAt, signal.source, `${signal.source} signal resolved: ${signal.title}`));
  return {
    ...incident,
    title: signal.id === incident.id ? signal.title : incident.title,
    severity: RANK[signal.severity] > RANK[incident.severity] ? signal.severity : incident.severity,
    service: incident.service ?? signal.service,
    signals,
    timeline: timeline.slice(-TIMELINE_MAX),
  };
}

/** Resolved by its own source signal (Datadog, Jira), or six quiet hours after its last signal update with every signal resolved
 *  (a Slack declaration has no state, so it does not hold the incident open). */
function settle(incident: Incident, now: Date): Incident {
  if (incident.status === "resolved") return incident;
  const starter = incident.signals.find((s) => s.id === incident.id);
  let resolvedAt: string | null = null;
  if (starter && stateful(starter)) {
    if (starter.status === "resolved") resolvedAt = starter.updatedAt;
  } else if (incident.signals.every((s) => s.status === "resolved" || s.source === "slack")) {
    const last = incident.signals.map((s) => s.updatedAt).sort().at(-1)!;
    if (now.getTime() - Date.parse(last) >= QUIET_RESOLVE_MS) resolvedAt = last;
  }
  if (resolvedAt === null) return incident;
  return { ...incident, status: "resolved", resolvedAt, timeline: [...incident.timeline, entry(resolvedAt, "machine", "Incident resolved")].slice(-TIMELINE_MAX) };
}

/** Folds `signals` into `incidents` and returns only the incidents that changed or began. A declaring signal starts or updates the
 *  incident of its own id; any other attaches to an open incident that began within two hours of `now` with the same service (or no
 *  service on either side), and starts one only when critical or high. A resolved incident is never reopened or attached to. */
export function foldSignals(incidents: Incident[], signals: IncidentSignal[], now: Date): Incident[] {
  const byId = new Map(incidents.map((i) => [i.id, i]));
  const touched = new Set<string>();
  const put = (incident: Incident) => {
    byId.set(incident.id, incident);
    touched.add(incident.id);
  };
  // Declaring signals first, so the Sentry issues of the same pass find their incident.
  for (const signal of [...signals].sort((a, b) => Number(declares(b)) - Number(declares(a)) || a.startedAt.localeCompare(b.startedAt))) {
    const home = [...byId.values()].find((i) => i.signals.some((s) => s.id === signal.id));
    if (home) {
      if (home.status === "open") put(absorb(home, signal));
      continue;
    }
    if (declares(signal)) {
      put(start(signal));
      continue;
    }
    const target = [...byId.values()]
      .filter((i) => i.status === "open" && now.getTime() - Date.parse(i.startedAt) <= ATTACH_WINDOW_MS && (i.service === null || signal.service === null || i.service === signal.service))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (target) put(absorb(target, signal));
    else if (loud(signal.severity)) put(start(signal));
  }
  // An open incident can also settle on the clock alone, with no new signal.
  for (const incident of incidents) touched.add(incident.id);
  const held = new Map(incidents.map((i) => [i.id, JSON.stringify(i)]));
  const out: Incident[] = [];
  for (const id of touched) {
    const settled = settle(byId.get(id)!, now);
    if (JSON.stringify(settled) !== held.get(id)) out.push(settled);
  }
  return out;
}

export type BreachRegime = "gdpr" | "lgpd" | "hipaa" | "us_privacy";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `days` working days after `from` (Saturdays and Sundays do not count), at the same time of day, UTC. */
function addWorkingDays(from: Date, days: number): Date {
  const date = new Date(from);
  for (let left = days; left > 0; ) {
    date.setTime(date.getTime() + DAY);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return date;
}

/** The notification deadline per regime, from the time the company became aware of the breach (`startedAt`, ISO):
 *  GDPR 72 hours (Art. 33); LGPD 3 working days (ANPD Resolution 15/2024); HIPAA 60 days (45 CFR 164.404); US state laws 30 days,
 *  the conservative earliest (state deadlines differ; a per-state setting can replace this later). Deadlines are ISO instants. */
export function breachClocks(startedAt: string, regimes: readonly BreachRegime[]): Partial<Record<BreachRegime, string>> {
  const from = new Date(startedAt);
  const due: Record<BreachRegime, Date> = {
    gdpr: new Date(from.getTime() + 72 * HOUR),
    lgpd: addWorkingDays(from, 3),
    hipaa: new Date(from.getTime() + 60 * DAY),
    us_privacy: new Date(from.getTime() + 30 * DAY),
  };
  return Object.fromEntries(regimes.map((regime) => [regime, due[regime].toISOString()]));
}
