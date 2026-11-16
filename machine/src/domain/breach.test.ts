import { describe, expect, it } from "vitest";

import { breachContext, regimesOf, type BreachAnswers } from "./breach.ts";
import type { Incident } from "./incident.ts";

const yes = { value: true, p: 0.9 };
const no = { value: false, p: 0.1 };
const answers = (over: Partial<BreachAnswers> = {}): BreachAnswers => ({ personal_data: no, phi: no, eu_subjects: no, br_subjects: no, us_subjects: no, subjects: { score: 0, confidence: 0.8 }, ...over });

describe("regimesOf", () => {
  it.each([
    ["nothing exposed", answers({ eu_subjects: yes, br_subjects: yes, us_subjects: yes }), []],
    ["personal data of people in the EU", answers({ personal_data: yes, eu_subjects: yes }), ["gdpr"]],
    ["personal data of people in Brazil", answers({ personal_data: yes, br_subjects: yes }), ["lgpd"]],
    ["personal data of people in the US", answers({ personal_data: yes, us_subjects: yes }), ["us_privacy"]],
    ["personal data of people in all three", answers({ personal_data: yes, eu_subjects: yes, br_subjects: yes, us_subjects: yes }), ["gdpr", "lgpd", "us_privacy"]],
    ["health information alone", answers({ phi: yes }), ["hipaa"]],
    ["health information of people in the US", answers({ personal_data: yes, phi: yes, us_subjects: yes }), ["hipaa", "us_privacy"]],
    ["personal data of nobody in particular", answers({ personal_data: yes }), []],
  ])("%s gives %j", (_name, given, regimes) => {
    expect(regimesOf(given)).toEqual(regimes);
  });
});

describe("breachContext", () => {
  const incident = (over: Partial<Incident> = {}): Incident => ({
    id: "jira:OPS-9",
    title: "Export bucket public",
    severity: "high",
    status: "open",
    startedAt: "2026-11-10T09:00:00.000Z",
    resolvedAt: null,
    service: "exports",
    signals: [{ source: "jira", id: "jira:OPS-9", title: "Export bucket public", severity: "high", status: "open", startedAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:00:00.000Z", url: "https://j/OPS-9", service: null, summary: "Jira OPS-9 Incident, Open." }],
    timeline: [{ at: "2026-11-10T09:00:00.000Z", source: "jira", text: "jira signal: Export bucket public" }],
    ...over,
  });

  it("carries the facts and each signal's title and summary, never its address", () => {
    const context = breachContext(incident());
    expect(context).toMatchObject({ title: "Export bucket public", severity: "high", service: "exports", startedAt: "2026-11-10T09:00:00.000Z" });
    expect(context.signals).toEqual([{ source: "jira", title: "Export bucket public", severity: "high", status: "open", summary: "Jira OPS-9 Incident, Open." }]);
    expect(JSON.stringify(context)).not.toContain("https://j/OPS-9");
  });

  it("keeps the newest 40 timeline entries and the first 20 signals", () => {
    const timeline = Array.from({ length: 55 }, (_, i) => ({ at: `2026-11-10T09:${String(i).padStart(2, "0")}:00.000Z`, source: "slack", text: `entry ${i}` }));
    const base = incident().signals[0]!;
    const signals = Array.from({ length: 25 }, (_, i) => ({ ...base, id: `sentry:${i}`, source: "sentry" as const }));
    const context = breachContext(incident({ timeline, signals }));
    expect(context.timeline).toHaveLength(40);
    expect(context.timeline[0]!.text).toBe("entry 15");
    expect(context.timeline.at(-1)!.text).toBe("entry 54");
    expect(context.signals).toHaveLength(20);
  });
});
