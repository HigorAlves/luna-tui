// Incidents (RFC 0008, wave 5). Every few minutes the sources the person configured (Sentry, Datadog, a Jira JQL, a Slack channel)
// give signals, which fold into incidents kept one JSON file each under `<stateDir>/compliance/incidents/`: owner-only, written
// atomically. A source with no credential or setting is not passed in and is never asked. A source that fails is logged and asked
// again on the next pass, with its cursor where it was. The hooks run after the incident is stored; one that throws is logged and
// never undoes the incident.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { foldSignals, type Incident } from "../domain/incident.ts";
import { fromDatadogIncident, fromDatadogMonitor, fromSentryIssue, SUMMARY_MAX, TITLE_MAX, type IncidentSeverity, type IncidentSignal } from "../domain/incident-signal.ts";
import { COMPLIANCE_DIR } from "./compliance-drafts.ts";
import type { Datadog } from "./datadog.ts";
import type { Jira, JiraIssue } from "./jira.ts";
import type { Sentry } from "./sentry.ts";
import type { RawMessage, Slack } from "./slack.ts";

const INCIDENTS_DIR = "incidents";
const FIRST_LOOK_MS = 24 * 3_600_000;
const POSTMORTEM_SPACING_MS = 3_600_000;
const POSTMORTEM_ATTEMPTS = 3;

const CursorSchema = z.object({ schema: z.literal(1), sentry: z.string().optional(), slack: z.string().optional() });
type Cursor = z.infer<typeof CursorSchema>;

export interface IncidentJobDeps {
  stateDir: string;
  sentry?: Sentry;
  datadog?: { port: Datadog; scope: string };
  jira?: { port: Pick<Jira, "search">; jql: string };
  slack?: { port: Pick<Slack, "history">; channel: string };
  /** After an incident is first stored (a resolved one found already resolved is started, then resolved). */
  onStarted?(incident: Incident): Promise<void>;
  /** After an incident goes from open to resolved. */
  onResolved?(incident: Incident): Promise<void>;
  /** The postmortem of a resolved incident: `has` says a draft for it already exists, `run` makes one (true when a draft opened).
   *  A resolved incident with none is tried on each tick, at most once an hour and 3 times in all. */
  postmortem?: { has(incidentId: string): Promise<boolean>; run(incident: Incident): Promise<boolean> };
  log?: (line: string) => void;
  now?: () => Date;
}

const fileNameOf = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}.json`;

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

const JIRA_PRIORITY: Record<string, IncidentSeverity> = { highest: "critical", high: "high", medium: "medium", low: "low", lowest: "low" };

export function fromJiraIssue(issue: JiraIssue, observedAt: string): IncidentSignal {
  return {
    source: "jira",
    id: `jira:${issue.key}`,
    title: oneLine(issue.summary, TITLE_MAX),
    severity: JIRA_PRIORITY[(issue.priority ?? "").toLowerCase()] ?? "unknown",
    status: issue.statusCategory === "done" ? "resolved" : "open",
    // Jira's port does not carry `created`: the stamp of its last change stands in until the incident is stored.
    startedAt: issue.updated ?? observedAt,
    updatedAt: issue.updated ?? observedAt,
    url: issue.url,
    service: issue.components?.[0] ?? null,
    summary: oneLine(`Jira ${issue.key} ${issue.issueType ?? "issue"}, ${issue.status ?? "no status"}.`, SUMMARY_MAX),
  };
}

export function fromSlackMessage(channel: string, message: RawMessage): IncidentSignal {
  const at = new Date(Number(message.ts) * 1000).toISOString();
  return {
    source: "slack",
    id: `slack:${channel}:${message.ts}`,
    title: oneLine(message.text, TITLE_MAX),
    severity: "unknown",
    status: "open",
    startedAt: at,
    updatedAt: at,
    url: null,
    service: null,
    summary: oneLine(message.text, SUMMARY_MAX),
  };
}

export class IncidentJob {
  private ticking: Promise<void> | null = null;
  private readonly dir: string;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: IncidentJobDeps) {
    this.dir = join(deps.stateDir, COMPLIANCE_DIR, INCIDENTS_DIR);
    this.log = deps.log ?? ((line) => console.warn(line));
    this.now = deps.now ?? (() => new Date());
  }

  /** Newest first (by when it started). A damaged file is skipped. */
  async list(): Promise<Incident[]> {
    const incidents: Incident[] = [];
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      try {
        incidents.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as Incident);
      } catch {
        this.log(`incidents: skipping the damaged file ${join(this.dir, name)}`);
      }
    }
    return incidents.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Sets fields on a stored incident (the breach assessment, say); null when there is no such incident. */
  async update(id: string, patch: Partial<Pick<Incident, "breach" | "postmortem">>): Promise<Incident | null> {
    const held = (await this.list()).find((i) => i.id === id);
    if (!held) return null;
    const next = { ...held, ...patch };
    await this.save(next);
    return next;
  }

  /** One pass; one already running is joined, not doubled. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    const cursor = await this.loadCursor();
    const held = await this.list();
    const signals: IncidentSignal[] = [];
    const fail = (source: string, error: unknown) => this.log(`incidents: ${source}: ${error instanceof Error ? error.message : String(error)}`);
    const next: Cursor = { ...cursor };
    const { sentry, datadog, jira, slack } = this.deps;

    if (sentry) {
      try {
        const issues = await sentry.newOrEscalatingIssues(cursor.sentry ?? new Date(now.getTime() - FIRST_LOOK_MS).toISOString());
        signals.push(...issues.map(fromSentryIssue));
        next.sentry = now.toISOString();
      } catch (error) {
        fail("sentry", error);
      }
    }
    if (datadog) {
      try {
        const incidents = await datadog.port.incidents();
        const monitors = await datadog.port.alertingMonitors(datadog.scope);
        const web = (path: string) => datadog.port.webUrl(path);
        const live = [...incidents.map((i) => fromDatadogIncident(i, web)), ...monitors.map((m) => fromDatadogMonitor(m, { webUrl: web, observedAt: now.toISOString() }))];
        signals.push(...live);
        // Datadog lists only what is still active, so an open signal that is gone from a complete listing has resolved.
        if (!incidents.incomplete && !monitors.incomplete) {
          const present = new Set(live.map((s) => s.id));
          for (const incident of held) {
            for (const signal of incident.signals) {
              if (signal.source === "datadog" && signal.status === "open" && !present.has(signal.id)) signals.push({ ...signal, status: "resolved", updatedAt: now.toISOString() });
            }
          }
        }
      } catch (error) {
        fail("datadog", error);
      }
    }
    if (jira) {
      try {
        const page = await jira.port.search(jira.jql, { maxResults: 50 });
        signals.push(...page.issues.map((issue) => fromJiraIssue(issue, now.toISOString())));
      } catch (error) {
        fail("jira", error);
      }
    }
    if (slack) {
      try {
        const messages = await slack.port.history(slack.channel, cursor.slack ?? String(Math.floor((now.getTime() - FIRST_LOOK_MS) / 1000)), 100);
        for (const message of messages) {
          if (message.subtype === null && message.text.trim() !== "" && (message.threadTs === null || message.threadTs === message.ts)) signals.push(fromSlackMessage(slack.channel, message));
        }
        const newest = messages.map((m) => m.ts).sort((a, b) => Number(a) - Number(b)).at(-1);
        if (newest) next.slack = newest;
      } catch (error) {
        fail("slack", error);
      }
    }

    const before = new Map(held.map((i) => [i.id, i]));
    for (const incident of foldSignals(held, signals, now)) {
      await this.save(incident);
      const prev = before.get(incident.id);
      await this.hook("onStarted", prev ? null : incident);
      if (incident.status === "resolved" && prev?.status !== "resolved") await this.hook("onResolved", incident);
    }
    await this.saveCursor(next);
    await this.retryPostmortems(now);
  }

  /** A resolved incident with no postmortem draft gets the run again: an hour apart, 3 tries in all, then it is the person's to write. */
  private async retryPostmortems(now: Date): Promise<void> {
    const postmortem = this.deps.postmortem;
    if (!postmortem) return;
    for (const incident of await this.list()) {
      if (incident.status !== "resolved" || incident.postmortem?.opened) continue;
      const tried = incident.postmortem;
      if (tried && (tried.attempts >= POSTMORTEM_ATTEMPTS || now.getTime() - Date.parse(tried.lastAttemptAt) < POSTMORTEM_SPACING_MS)) continue;
      try {
        if (await postmortem.has(incident.id)) continue;
        const attempts = (tried?.attempts ?? 0) + 1;
        await this.save({ ...incident, postmortem: { attempts, lastAttemptAt: now.toISOString() } });
        let opened = false;
        try {
          opened = await postmortem.run(incident);
        } catch (error) {
          this.log(`incidents: postmortem for ${incident.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (opened) await this.save({ ...incident, postmortem: { attempts, lastAttemptAt: now.toISOString(), opened: true } });
        if (!opened && attempts >= POSTMORTEM_ATTEMPTS) this.log(`incidents: no postmortem for ${incident.id} after ${attempts} tries: you can write it by hand`);
      } catch (error) {
        this.log(`incidents: postmortem for ${incident.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async hook(name: "onStarted" | "onResolved", incident: Incident | null): Promise<void> {
    const run = this.deps[name];
    if (!run || !incident) return;
    try {
      await run(incident);
    } catch (error) {
      this.log(`incidents: ${name} for ${incident.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async save(incident: Incident): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.write(join(this.dir, fileNameOf(incident.id)), `${JSON.stringify(incident, null, 2)}\n`);
  }

  private cursorFile(): string {
    return join(this.deps.stateDir, COMPLIANCE_DIR, "incidents-cursor.json");
  }

  /** A damaged or missing file is an empty cursor: each source looks back a day. */
  private async loadCursor(): Promise<Cursor> {
    try {
      const parsed = CursorSchema.safeParse(JSON.parse(await readFile(this.cursorFile(), "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // No file, or not JSON.
    }
    return { schema: 1 };
  }

  private async saveCursor(cursor: Cursor): Promise<void> {
    await mkdir(join(this.deps.stateDir, COMPLIANCE_DIR), { recursive: true, mode: 0o700 });
    await this.write(this.cursorFile(), JSON.stringify(cursor));
  }

  /** Temp file, owner-only, then rename: a reader never sees half a file. */
  private async write(path: string, text: string): Promise<void> {
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, text, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
