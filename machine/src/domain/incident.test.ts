import { describe, expect, it } from "vitest";

import { breachClocks, foldSignals } from "./incident.ts";
import type { IncidentSignal } from "./incident-signal.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const signal = (over: Partial<IncidentSignal> = {}): IncidentSignal => ({
  source: "sentry",
  id: "sentry:1",
  title: "TypeError in checkout",
  severity: "high",
  status: "open",
  startedAt: at(-1),
  updatedAt: at(-1),
  url: null,
  service: "api",
  summary: "Sentry API-1: 40 events, 12 users.",
  ...over,
});
const datadog = (over: Partial<IncidentSignal> = {}) => signal({ source: "datadog", id: "datadog:incident:812", title: "Checkout down", severity: "critical", service: null, ...over });

describe("foldSignals", () => {
  it("starts an incident from a Datadog incident, a Jira incident and a Slack declaration, each its own", () => {
    const out = foldSignals(
      [],
      [datadog(), signal({ source: "jira", id: "jira:OPS-9", service: null }), signal({ source: "slack", id: "slack:C1:1.2", service: null })],
      NOW,
    );
    expect(out.map((i) => i.id).sort()).toEqual(["datadog:incident:812", "jira:OPS-9", "slack:C1:1.2"]);
    expect(out.every((i) => i.status === "open" && i.resolvedAt === null)).toBe(true);
    const first = out.find((i) => i.id === "datadog:incident:812")!;
    expect(first.severity).toBe("critical");
    expect(first.signals).toHaveLength(1);
    expect(first.timeline[0]!.source).toBe("datadog");
  });

  it("updates the incident of a signal it has seen, without a second timeline start", () => {
    const [held] = foldSignals([], [datadog()], NOW);
    const out = foldSignals([held!], [datadog({ title: "Checkout down (EU)", updatedAt: at(0) })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Checkout down (EU)");
    expect(out[0]!.signals).toHaveLength(1);
    expect(out[0]!.timeline).toHaveLength(1);
  });

  it("attaches a critical or high Sentry issue to an open incident under 2 hours old with the same service or none", () => {
    const [base] = foldSignals([], [signal({ source: "jira", id: "jira:OPS-9", service: null, startedAt: at(-1) })], NOW);
    const out = foldSignals([base!], [signal()], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("jira:OPS-9");
    expect(out[0]!.signals.map((s) => s.id)).toEqual(["jira:OPS-9", "sentry:1"]);
    expect(out[0]!.service).toBe("api");
    expect(out[0]!.timeline).toHaveLength(2);
  });

  it("starts an incident for a high Sentry issue when the open one is older than 2 hours or has another service", () => {
    const old = foldSignals([], [signal({ source: "jira", id: "jira:OPS-9", service: null, startedAt: at(-3) })], NOW)[0]!;
    expect(foldSignals([old], [signal()], NOW).map((i) => i.id)).toEqual(["sentry:1"]);
    const other = foldSignals([], [signal({ id: "sentry:7", service: "billing" })], NOW)[0]!;
    expect(foldSignals([other], [signal()], NOW).map((i) => i.id)).toEqual(["sentry:1"]);
  });

  it("attaches a medium or low signal but never starts an incident from it", () => {
    expect(foldSignals([], [signal({ severity: "medium" }), signal({ id: "sentry:2", severity: "low" })], NOW)).toEqual([]);
    const [base] = foldSignals([], [datadog()], NOW);
    const out = foldSignals([base!], [signal({ severity: "medium" })], NOW);
    expect(out[0]!.signals.map((s) => s.id)).toEqual(["datadog:incident:812", "sentry:1"]);
  });

  it("raises the incident's severity to its worst signal", () => {
    const [base] = foldSignals([], [signal({ source: "jira", id: "jira:OPS-9", severity: "medium", service: null })], NOW);
    expect(foldSignals([base!], [signal({ severity: "critical" })], NOW)[0]!.severity).toBe("critical");
  });

  it("resolves a Datadog or Jira incident when its signal resolves", () => {
    const [base] = foldSignals([], [datadog()], NOW);
    const out = foldSignals([base!], [datadog({ status: "resolved", updatedAt: at(-0.5) })], NOW);
    expect(out[0]!.status).toBe("resolved");
    expect(out[0]!.resolvedAt).toBe(at(-0.5));
    expect(out[0]!.timeline.at(-1)!.text).toMatch(/resolved/i);
  });

  it("resolves a Sentry-started incident after 6 hours with every signal resolved, not before", () => {
    const [base] = foldSignals([], [signal({ startedAt: at(-8), updatedAt: at(-8) })], NOW);
    const early = foldSignals([base!], [signal({ status: "resolved", startedAt: at(-8), updatedAt: at(-5) })], NOW);
    expect(early[0]!.status).toBe("open");
    const late = foldSignals([early[0]!], [signal({ status: "resolved", startedAt: at(-8), updatedAt: at(-6) })], NOW);
    expect(late[0]!.status).toBe("resolved");
    expect(late[0]!.resolvedAt).toBe(at(-6));
  });

  it("keeps a Sentry-started incident open while one attached signal is still open", () => {
    const [base] = foldSignals([], [signal({ updatedAt: at(-9), startedAt: at(-9) }), signal({ id: "sentry:2", severity: "medium", startedAt: at(-9), updatedAt: at(-9) })], new Date(at(-9)));
    const out = foldSignals([base!], [signal({ status: "resolved", startedAt: at(-9), updatedAt: at(-8) })], NOW);
    expect(out[0]!.status).toBe("open");
  });

  it("returns nothing for a signal that changes nothing", () => {
    const [base] = foldSignals([], [datadog()], NOW);
    expect(foldSignals([base!], [datadog()], NOW)).toEqual([]);
  });

  it("clips a timeline line at 300 characters", () => {
    const out = foldSignals([], [datadog({ title: "x".repeat(400) })], NOW);
    expect(out[0]!.timeline[0]!.text.length).toBeLessThanOrEqual(300);
  });
});

describe("breachClocks", () => {
  // Wed 2026-11-11 is a working day; Fri 2026-11-13 and Sat 2026-11-14 test the weekend skip.
  it.each([
    ["gdpr", "2026-11-11T10:30:00.000Z", "2026-11-14T10:30:00.000Z"],
    ["hipaa", "2026-11-11T10:30:00.000Z", "2027-01-10T10:30:00.000Z"],
    ["us_privacy", "2026-11-11T10:30:00.000Z", "2026-12-11T10:30:00.000Z"],
    ["lgpd", "2026-11-11T10:30:00.000Z", "2026-11-16T10:30:00.000Z"],
    ["lgpd", "2026-11-13T10:30:00.000Z", "2026-11-18T10:30:00.000Z"],
    ["lgpd", "2026-11-14T10:30:00.000Z", "2026-11-18T10:30:00.000Z"],
    ["lgpd", "2026-11-09T08:00:00.000Z", "2026-11-12T08:00:00.000Z"],
  ] as const)("%s from %s is due %s", (regime, from, due) => {
    expect(breachClocks(from, [regime])).toEqual({ [regime]: due });
  });

  it("gives one deadline per regime and none for no regimes", () => {
    expect(Object.keys(breachClocks("2026-11-11T10:30:00.000Z", ["gdpr", "hipaa"])).sort()).toEqual(["gdpr", "hipaa"]);
    expect(breachClocks("2026-11-11T10:30:00.000Z", [])).toEqual({});
  });
});
