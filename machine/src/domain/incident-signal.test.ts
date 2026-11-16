import { describe, expect, it } from "vitest";

import type { DdIncident, DdMonitorGroup } from "../application/datadog.ts";
import type { SentryIssue } from "../application/sentry.ts";
import { fromDatadogIncident, fromDatadogMonitor, fromSentryIssue } from "./incident-signal.ts";

const webUrl = (path: string) => `https://app.datadoghq.eu/${path}`;
const OBSERVED = "2026-11-16T10:00:00.000Z";

const dd = (over: Partial<DdIncident> = {}): DdIncident => ({
  id: "00000000-0000-4a1b-8000-000000000812",
  publicId: 812,
  title: "Checkout failing for EU customers",
  state: "active",
  severity: "SEV-2",
  customerImpacted: true,
  created: "2026-10-28T08:14:03.221Z",
  modified: "2026-10-28T09:02:47.510Z",
  ...over,
});
const monitor = (over: Partial<DdMonitorGroup> = {}): DdMonitorGroup => ({
  monitorId: 4411,
  monitorName: "API gateway 5xx rate is high",
  group: "service:api-gateway,env:prod",
  status: "Alert",
  priority: null,
  lastTriggered: "2026-10-27T10:00:00.000Z",
  ...over,
});
const sentry = (over: Partial<SentryIssue> = {}): SentryIssue => ({
  id: "4501234567",
  shortId: "API-GATEWAY-3F",
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  culprit: "POST /v2/checkout",
  level: "error",
  status: "unresolved",
  count: 1342,
  userCount: 87,
  firstSeen: "2026-11-15T22:04:11.000Z",
  lastSeen: "2026-11-16T09:41:50.000Z",
  permalink: "https://sentry.io/organizations/acme/issues/4501234567/",
  project: "api-gateway",
  ...over,
});

describe("fromDatadogIncident", () => {
  it("maps the whole incident", () => {
    expect(fromDatadogIncident(dd(), webUrl)).toEqual({
      source: "datadog",
      id: "datadog:incident:812",
      title: "Checkout failing for EU customers",
      severity: "high",
      status: "open",
      startedAt: "2026-10-28T08:14:03.221Z",
      updatedAt: "2026-10-28T09:02:47.510Z",
      url: "https://app.datadoghq.eu/incidents/812",
      service: null,
      summary: "Datadog incident SEV-2, active, customers impacted.",
    });
  });
  it.each([
    ["SEV-1", "critical"],
    ["SEV-2", "high"],
    ["SEV-3", "medium"],
    ["SEV-4", "low"],
    ["SEV-5", "low"],
    ["sev-1", "critical"],
    ["UNKNOWN", "unknown"],
    [null, "unknown"],
    ["P1", "unknown"],
  ])("severity %s is %s", (severity, expected) => {
    expect(fromDatadogIncident(dd({ severity }), webUrl).severity).toBe(expected);
  });
  it.each([
    ["active", "open"],
    ["stable", "open"],
    ["Active", "open"],
    ["resolved", "resolved"],
    ["completed", "resolved"],
    ["Resolved", "resolved"],
  ])("state %s is %s", (state, expected) => {
    expect(fromDatadogIncident(dd({ state }), webUrl).status).toBe(expected);
  });
  it("says nothing about customers when none are impacted", () => {
    expect(fromDatadogIncident(dd({ customerImpacted: false }), webUrl).summary).toBe("Datadog incident SEV-2, active.");
  });
});

describe("fromDatadogMonitor", () => {
  it("maps an alerting group, with its service from the group's tags", () => {
    expect(fromDatadogMonitor(monitor(), { webUrl, observedAt: OBSERVED })).toEqual({
      source: "datadog",
      id: "datadog:monitor:4411:service:api-gateway,env:prod",
      title: "API gateway 5xx rate is high (service:api-gateway,env:prod)",
      severity: "high",
      status: "open",
      startedAt: "2026-10-27T10:00:00.000Z",
      updatedAt: OBSERVED,
      url: "https://app.datadoghq.eu/monitors/4411",
      service: "api-gateway",
      summary: "Datadog monitor in Alert for service:api-gateway,env:prod.",
    });
  });
  it.each([
    ["Alert", null, "high"],
    ["Warn", null, "medium"],
    ["No Data", null, "low"],
    ["OK", null, "unknown"],
    ["Alert", 1, "critical"],
    ["Alert", 2, "high"],
    ["Warn", 3, "medium"],
    ["Alert", 4, "low"],
    ["Alert", 5, "low"],
  ])("status %s with priority %s is %s", (status, priority, expected) => {
    expect(fromDatadogMonitor(monitor({ status, priority }), { webUrl, observedAt: OBSERVED }).severity).toBe(expected);
  });
  it("a monitor without groups has the bare name, no service and a stable id", () => {
    const signal = fromDatadogMonitor(monitor({ group: "*", lastTriggered: null }), { webUrl, observedAt: OBSERVED });
    expect(signal).toMatchObject({ id: "datadog:monitor:4411:*", title: "API gateway 5xx rate is high", service: null, startedAt: OBSERVED });
  });
  it("a recovered monitor is resolved", () => {
    expect(fromDatadogMonitor(monitor({ status: "OK" }), { webUrl, observedAt: OBSERVED }).status).toBe("resolved");
  });
});

describe("fromSentryIssue", () => {
  it("maps the whole issue", () => {
    expect(fromSentryIssue(sentry())).toEqual({
      source: "sentry",
      id: "sentry:4501234567",
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      severity: "high",
      status: "open",
      startedAt: "2026-11-15T22:04:11.000Z",
      updatedAt: "2026-11-16T09:41:50.000Z",
      url: "https://sentry.io/organizations/acme/issues/4501234567/",
      service: "api-gateway",
      summary: "Sentry API-GATEWAY-3F in POST /v2/checkout: 1342 events, 87 users.",
    });
  });
  it.each([
    ["fatal", "critical"],
    ["error", "high"],
    ["warning", "medium"],
    ["info", "low"],
    ["debug", "low"],
    ["FATAL", "critical"],
    ["sample", "unknown"],
  ])("level %s is %s", (level, expected) => {
    expect(fromSentryIssue(sentry({ level })).severity).toBe(expected);
  });
  it.each([
    ["unresolved", "open"],
    ["resolved", "resolved"],
    ["ignored", "resolved"],
  ])("status %s is %s", (status, expected) => {
    expect(fromSentryIssue(sentry({ status })).status).toBe(expected);
  });
  it("leaves the culprit out of the summary when there is none, and counts one of each in the singular", () => {
    expect(fromSentryIssue(sentry({ culprit: "", count: 1, userCount: 1 })).summary).toBe("Sentry API-GATEWAY-3F: 1 event, 1 user.");
  });
});

describe("summary and title", () => {
  it("keeps a summary at 500 characters at most, on one line, whatever the culprit holds", () => {
    const culprit = `at handler (app.js:10:5)\n    at run (app.js:20:1)\n${"x".repeat(2000)}`;
    const signal = fromSentryIssue(sentry({ culprit }));
    expect(signal.summary.length).toBeLessThanOrEqual(500);
    expect(signal.summary).not.toMatch(/\n/);
    expect(signal.summary.endsWith("…")).toBe(true);
  });
  it("clips an oversized title and collapses its whitespace", () => {
    const signal = fromDatadogIncident(dd({ title: `Outage\n\n${"y".repeat(1000)}` }), webUrl);
    expect(signal.title.length).toBeLessThanOrEqual(200);
    expect(signal.title).not.toMatch(/\n/);
    expect(signal.title.startsWith("Outage y")).toBe(true);
  });
});
