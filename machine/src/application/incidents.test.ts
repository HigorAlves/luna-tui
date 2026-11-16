import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Incident } from "../domain/incident.ts";
import type { DdIncident, DdMonitorGroup, Datadog } from "./datadog.ts";
import { IncidentJob, type IncidentJobDeps } from "./incidents.ts";
import type { JiraIssue } from "./jira.ts";
import type { RawMessage } from "./slack.ts";
import type { Sentry, SentryIssue } from "./sentry.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const iso = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const ddIncident = (over: Partial<DdIncident> = {}): DdIncident => ({ id: "x", publicId: 812, title: "Checkout failing", state: "active", severity: "SEV-2", customerImpacted: true, created: iso(-1), modified: iso(-0.5), ...over });
const ddMonitor = (over: Partial<DdMonitorGroup> = {}): DdMonitorGroup => ({ monitorId: 44, monitorName: "5xx high", group: "service:api", status: "Alert", priority: null, lastTriggered: iso(-1), ...over });
const sentryIssue = (over: Partial<SentryIssue> = {}): SentryIssue => ({ id: "9", shortId: "API-9", title: "TypeError", culprit: "checkout", level: "error", status: "unresolved", count: 3, userCount: 2, firstSeen: iso(-1), lastSeen: iso(-0.2), permalink: "https://sentry.io/9", project: "api", ...over });
const jiraIssue = (over: Partial<JiraIssue> = {}): JiraIssue => ({ key: "OPS-9", url: "https://j/OPS-9", summary: "Data export outage", description: "", status: "Open", statusCategory: "indeterminate", issueType: "Incident", priority: "Highest", dueAt: null, labels: [], updated: iso(-1), comments: [], ...over });
const slackMessage = (over: Partial<RawMessage> = {}): RawMessage => ({ ts: "1794830000.000100", user: "U1", botId: null, text: "Declaring an incident: login is down", subtype: null, threadTs: null, replyCount: 0, latestReply: null, ...over });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "incidents-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const fakeDatadog = (incidents: DdIncident[] = [], monitors: DdMonitorGroup[] = []): Datadog => ({
  incidents: async () => incidents,
  alertingMonitors: async () => monitors,
  errorTrackingIssues: async () => [],
  webUrl: (path) => `https://app.datadoghq.com/${path}`,
});

const job = (over: Partial<IncidentJobDeps> = {}) => new IncidentJob({ stateDir: dir, now: () => NOW, log: () => {}, ...over });
const stored = async (): Promise<Incident[]> => {
  const folder = join(dir, "compliance", "incidents");
  const names = (await readdir(folder).catch(() => [])).filter((n) => n.endsWith(".json"));
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), "utf8")) as Incident));
};

describe("IncidentJob", () => {
  it("does nothing, and says nothing, with no source", async () => {
    const log = vi.fn();
    await job({ log }).tick();
    expect(await stored()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("stores an incident from a Datadog incident, owner-only, and tells the start hook once", async () => {
    const started = vi.fn();
    const j = job({ datadog: { port: fakeDatadog([ddIncident()]), scope: "" }, onStarted: started });
    await j.tick();
    await j.tick();
    const [incident] = await stored();
    expect(incident).toMatchObject({ id: "datadog:incident:812", severity: "high", status: "open" });
    expect(started).toHaveBeenCalledTimes(1);
    const file = join(dir, "compliance", "incidents", (await readdir(join(dir, "compliance", "incidents")))[0]!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("resolves a Datadog incident that left the active list, and tells the resolve hook", async () => {
    const resolved = vi.fn();
    let listed = [ddIncident()];
    const port = { ...fakeDatadog(), incidents: async () => listed };
    const j = job({ datadog: { port, scope: "" }, onResolved: resolved });
    await j.tick();
    listed = [];
    await j.tick();
    const [incident] = await stored();
    expect(incident).toMatchObject({ status: "resolved", resolvedAt: NOW.toISOString() });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0]![0]).toMatchObject({ id: "datadog:incident:812", status: "resolved" });
  });

  it("attaches a high Sentry issue and an alerting monitor to the incident, asking Sentry since the cursor", async () => {
    const asked: string[] = [];
    const sentry: Sentry = { newOrEscalatingIssues: async (since) => (asked.push(since), [sentryIssue({ project: "api" })]) };
    const j = job({ datadog: { port: fakeDatadog([ddIncident()], [ddMonitor()]), scope: "" }, sentry });
    await j.tick();
    await j.tick();
    const [incident] = await stored();
    expect(incident!.signals.map((s) => s.id).sort()).toEqual(["datadog:incident:812", "datadog:monitor:44:service:api", "sentry:9"]);
    expect(asked[0]).toBe(iso(-24));
    expect(asked[1]).toBe(NOW.toISOString());
  });

  it("starts an incident from the Jira issues of the JQL, mapping priority and status category", async () => {
    const jqls: string[] = [];
    const jira = { search: async (jql: string) => (jqls.push(jql), { issues: [jiraIssue(), jiraIssue({ key: "OPS-10", priority: "Low", statusCategory: "done" })], nextPageToken: null }) };
    await job({ jira: { port: jira, jql: "issuetype = Incident" } }).tick();
    const incidents = await stored();
    expect(jqls).toEqual(["issuetype = Incident"]);
    expect(incidents.find((i) => i.id === "jira:OPS-9")).toMatchObject({ severity: "critical", status: "open", title: "Data export outage" });
    expect(incidents.find((i) => i.id === "jira:OPS-10")).toMatchObject({ status: "resolved" });
  });

  it("reads only the top-level, plain messages of the Slack channel, from the cursor on", async () => {
    const calls: Array<[string, string]> = [];
    const slack = {
      history: async (channel: string, oldest: string) => (calls.push([channel, oldest]), [slackMessage(), slackMessage({ ts: "1794830001.000200", threadTs: "1794830000.000100" }), slackMessage({ ts: "1794830002.000300", subtype: "channel_join" })]),
    };
    const j = job({ slack: { port: slack, channel: "C0123" } });
    await j.tick();
    const incidents = await stored();
    expect(incidents.map((i) => i.id)).toEqual(["slack:C0123:1794830000.000100"]);
    expect(incidents[0]!.title).toBe("Declaring an incident: login is down");
    await j.tick();
    expect(calls[1]![1]).toBe("1794830002.000300");
  });

  it("logs a source that fails, keeps its cursor and still folds the others", async () => {
    const log = vi.fn();
    const sentry: Sentry = { newOrEscalatingIssues: async () => Promise.reject(new Error("sentry is down")) };
    await job({ log, sentry, datadog: { port: fakeDatadog([ddIncident()]), scope: "" } }).tick();
    expect((await stored()).map((i) => i.id)).toEqual(["datadog:incident:812"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sentry is down"));
  });

  it("does not let a hook's failure undo the stored incident", async () => {
    const log = vi.fn();
    await job({ log, datadog: { port: fakeDatadog([ddIncident()]), scope: "" }, onStarted: async () => Promise.reject(new Error("no model")) }).tick();
    expect(await stored()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no model"));
  });

  it("keeps what a hook attaches to an incident through the next pass", async () => {
    const j = job({
      datadog: { port: fakeDatadog([ddIncident()]), scope: "" },
      onStarted: async (incident) => void (await j.update(incident.id, { breach: { error: "agents are off" } })),
    });
    await j.tick();
    await j.tick();
    expect((await stored())[0]!.breach).toEqual({ error: "agents are off" });
  });

  it("answers an update of an incident it does not hold with null", async () => {
    expect(await job().update("nope", { breach: { error: "x" } })).toBeNull();
  });

  it("lists the incidents newest first", async () => {
    const j = job({ datadog: { port: fakeDatadog([ddIncident(), ddIncident({ publicId: 813, created: iso(-0.5) })]), scope: "" } });
    await j.tick();
    expect((await j.list()).map((i) => i.id)).toEqual(["datadog:incident:813", "datadog:incident:812"]);
  });
});
