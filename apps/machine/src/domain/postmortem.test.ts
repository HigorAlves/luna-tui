import type { PostmortemAnswer } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { Incident } from "./incident.ts";
import { postmortemContext, postmortemPage, postmortemPath, postmortemSummary } from "./postmortem.ts";

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: "jira:OPS-9",
  title: "Export bucket: public!",
  severity: "high",
  status: "resolved",
  startedAt: "2026-11-10T09:00:00.000Z",
  resolvedAt: "2026-11-10T15:00:00.000Z",
  service: "exports",
  signals: [{ source: "jira", id: "jira:OPS-9", title: "Export bucket public", severity: "high", status: "resolved", startedAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T15:00:00.000Z", url: "https://j/OPS-9", service: null, summary: "Jira OPS-9 Incident, Done." }],
  timeline: [],
  ...over,
});
const answer: PostmortemAnswer = {
  summary: "A bucket served the export.",
  impact: "The export was readable for six hours.",
  timeline: [{ at: "2026-11-10T09:00:00.000Z", text: "Declared." }],
  rootCauses: ["A migration widened the bucket policy."],
  contributingFactors: ["No alert on public access."],
  actionItems: [
    { title: "Add a public-access check to the deploy", owner: "platform", due: "2026-12-01" },
    { title: "Alert on public buckets", owner: null, due: null },
  ],
  breachNotes: "Notify the supervisory authority within 72 hours.",
};
const breach = { assessedAt: "2026-11-10T09:05:00.000Z", answers: {} as never, regimes: ["gdpr" as const, "hipaa" as const], clocks: { gdpr: "2026-11-13T09:00:00.000Z", hipaa: "2027-01-09T09:00:00.000Z" } };

describe("postmortemContext", () => {
  it("carries the incident without addresses, and the regimes and clocks of a successful assessment only", () => {
    const withBreach = postmortemContext(incident({ breach }));
    expect(withBreach.breach).toEqual({ regimes: ["gdpr", "hipaa"], clocks: breach.clocks });
    expect(withBreach.incident).toMatchObject({ title: "Export bucket: public!", resolvedAt: "2026-11-10T15:00:00.000Z" });
    expect(JSON.stringify(withBreach)).not.toContain("https://j/OPS-9");
    expect(postmortemContext(incident()).breach).toBeNull();
    expect(postmortemContext(incident({ breach: { error: "agents are off" } })).breach).toBeNull();
    expect(postmortemContext(incident({ breach: { ...breach, error: "rate limited", errorAt: "2026-11-12T00:00:00.000Z" } })).breach).toEqual({ regimes: ["gdpr", "hipaa"], clocks: breach.clocks });
  });
});

describe("postmortemPath", () => {
  it("is Incidents/<start date>-<slug>-<short hash of the id>.md", () => {
    expect(postmortemPath(incident())).toMatch(/^Incidents\/2026-11-10-export-bucket-public-[0-9a-f]{6}\.md$/);
    expect(postmortemPath(incident({ title: "!!!" }))).toMatch(/^Incidents\/2026-11-10-incident-[0-9a-f]{6}\.md$/);
  });

  it("differs for two incidents with one title on one day, and is stable for one incident", () => {
    const first = incident({ id: "datadog:monitor:7@2026-11-10T09:00:00.000Z" });
    const second = incident({ id: "datadog:monitor:7@2026-11-10T14:00:00.000Z" });
    expect(postmortemPath(first)).not.toBe(postmortemPath(second));
    expect(postmortemPath(first)).toBe(postmortemPath({ ...first }));
  });
});

describe("postmortemSummary", () => {
  it("names the severity, the action items and the nearest clock", () => {
    expect(postmortemSummary(incident(), answer)).toBe("high · 2 action items");
    expect(postmortemSummary(incident({ breach }), answer)).toBe("high · 2 action items · ⏱ gdpr by 2026-11-13");
    expect(postmortemSummary(incident(), { ...answer, actionItems: answer.actionItems.slice(0, 1) })).toBe("high · 1 action item");
  });
});

describe("postmortemPage", () => {
  it("has the sections in order, action items as a checklist with owner and due", () => {
    const page = postmortemPage(incident({ breach }), answer);
    const headings = page.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Summary", "## Impact", "## Breach and notification deadlines", "## Timeline", "## Root causes", "## Contributing factors", "## Action items"]);
    expect(page).toMatch(/^# Postmortem: Export bucket: public!/);
    expect(page).toContain("- [ ] Add a public-access check to the deploy (owner: platform, due: 2026-12-01)");
    expect(page).toContain("- [ ] Alert on public buckets (owner: unassigned, due: none)");
    expect(page).toContain("- gdpr: by 2026-11-13T09:00:00.000Z");
    expect(page).toContain("Notify the supervisory authority within 72 hours.");
    expect(page).toContain("- 2026-11-10T09:00:00.000Z: Declared.");
  });

  it("leaves out the breach section when there are no regimes", () => {
    expect(postmortemPage(incident(), { ...answer, breachNotes: null })).not.toContain("Breach and notification");
  });
});
