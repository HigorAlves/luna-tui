import type { StatusReportAnswer, StatusReportContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { isoWeek, statusPage, statusPath, summaryOf, weekBounds, wikiPageUrl } from "./status-report.ts";

const facts: StatusReportContext = {
  week: "2026-W46",
  from: "2026-11-09",
  to: "2026-11-15",
  metrics: { created: 9, closed: 7, open: 12, waitingOnYou: 2, leadTimeHours: 31.5, firstPassRate: 0.8, escalationRate: null, costUsd: 42.5 },
  shipped: [{ title: "Export a report as CSV", repo: "acme/api", pr: "acme/api#38" }],
  inFlight: [{ title: "Rate limits per tenant", state: "implementing" }],
  blocked: [{ title: "Migrate auth", why: "waiting on an answer" }],
  merged: [{ repo: "acme/api", count: 14 }],
  compliance: {
    waitingDrafts: [{ kind: "change_evidence", title: "Change management, acme/api, 2026-10" }],
    evidence: [{ repo: "acme/api", period: "2026-10", exceptions: 3 }],
    access: [{ org: "acme", period: "2026-Q4", flags: 4, signed: false }],
    incidents: [{ title: "Export bucket public", severity: "high", status: "open", nextDeadline: { regime: "GDPR", at: "2026-11-18T09:00:00.000Z" } }],
    vulns: [{ repo: "acme/api", severity: "high", deadline: "2026-11-20", overdue: true }],
  },
  capacity: { answers: { overAgentCapacity: true, overReviewCapacity: false, atRisk: "some" } },
};

const answer: StatusReportAnswer = {
  headline: "Seven cards shipped; the auth migration slips",
  shipped: ["CSV export is live"],
  risks: ["Auth migration waits on an answer"],
  compliance: ["3 change exceptions in acme/api for 2026-10"],
  asks: ["Decide whether to add a contractor for the auth migration"],
  summary: "Seven shipped. Auth slips.",
};

describe("statusPath and wikiPageUrl", () => {
  it.each([
    ["2026-W46", "Status/2026-W46.md"],
    ["2027-W01", "Status/2027-W01.md"],
  ])("puts week %s at %s", (week, path) => {
    expect(statusPath(week)).toBe(path);
  });

  it.each([
    ["acme/api", "Status/2026-W46.md", "https://github.com/acme/api/wiki/2026-W46"],
    ["acme/home", "Status/2027-W01.md", "https://github.com/acme/home/wiki/2027-W01"],
    ["acme/api", "Plain.md", "https://github.com/acme/api/wiki/Plain"],
    ["acme/api", "a/b/c.page.md", "https://github.com/acme/api/wiki/c.page"],
    ["acme/api", "No-Extension", "https://github.com/acme/api/wiki/No-Extension"],
  ])("addresses %s %s by the page's basename", (repo, path, url) => {
    expect(wikiPageUrl(repo, path)).toBe(url);
  });
});

describe("isoWeek and weekBounds", () => {
  it.each([
    ["2026-11-16T09:00:00", "2026-W47"],
    ["2026-11-15T23:59:00", "2026-W46"],
    ["2027-01-03T12:00:00", "2026-W53"],
    ["2027-01-04T00:00:00", "2027-W01"],
    ["2024-12-30T10:00:00", "2025-W01"],
  ])("names %s as %s", (iso, week) => {
    expect(isoWeek(new Date(iso))).toBe(week);
  });

  it.each([
    ["2026-W46", "2026-11-09", "2026-11-15"],
    ["2026-W53", "2026-12-28", "2027-01-03"],
    ["2025-W01", "2024-12-30", "2025-01-05"],
  ])("runs %s from %s to %s", (week, from, to) => {
    expect(weekBounds(week)).toEqual({ from, to });
  });
});

describe("statusPage", () => {
  const page = statusPage("2026-W46", answer, facts);

  it("has the summary, headline, shipped, in flight, risks, compliance, capacity, asks and facts sections in that order", () => {
    const headings = page.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Summary", "## Headline", "## Shipped", "## In flight", "## Risks", "## Compliance", "## Capacity", "## Asks", "## Facts"]);
    expect(page.startsWith("# Status, 2026-W46\n")).toBe(true);
    expect(page).toContain("2026-11-09 to 2026-11-15");
  });

  it("carries the answer's text and the facts' own lists", () => {
    expect(page).toContain("## Summary\n\nSeven shipped. Auth slips.\n");
    expect(page).toContain("## Headline\n\nSeven cards shipped; the auth migration slips\n");
    expect(page).toContain("- CSV export is live");
    expect(page).toContain("- Rate limits per tenant (implementing)");
    expect(page).toContain("- Auth migration waits on an answer");
    expect(page).toContain("- Decide whether to add a contractor for the auth migration");
  });

  it("states the capacity answers, or says it was not assessed", () => {
    expect(page).toContain("- Over agent capacity: yes\n- Over review capacity: no\n- Items at risk: some");
    expect(statusPage("2026-W46", answer, { ...facts, capacity: null })).toContain("## Capacity\n\nNot assessed.");
  });

  it("ends with a facts appendix of the counts, the metrics and the compliance lists, computed by code", () => {
    const appendix = page.slice(page.indexOf("## Facts"));
    expect(appendix).toContain("Cards: 9 created, 7 closed, 12 open, 2 waiting on you");
    expect(appendix).toContain("Lead time: 31.5 h");
    expect(appendix).toContain("First pass: 80%");
    expect(appendix).toContain("Escalation rate: unknown");
    expect(appendix).toContain("Cost: $42.50");
    expect(appendix).toContain("acme/api: 14 PRs merged");
    expect(appendix).toContain("Change evidence: acme/api 2026-10, 3 exceptions");
    expect(appendix).toContain("Access review: acme 2026-Q4, 4 flags, not signed");
    expect(appendix).toContain("Incident: [high, open] Export bucket public; next deadline GDPR 2026-11-18T09:00:00.000Z");
    expect(appendix).toContain("Vulnerability: acme/api high, due 2026-11-20, overdue");
    expect(appendix).toContain("Draft waiting: change_evidence, Change management, acme/api, 2026-10");
  });

  it("says nothing happened under an empty section, and the appendix keeps working with empty facts", () => {
    const empty = statusPage("2026-W46", { headline: "Quiet week", shipped: [], risks: [], compliance: [], asks: [], summary: "Quiet." }, { ...facts, shipped: [], inFlight: [], blocked: [], merged: [], compliance: { waitingDrafts: [], evidence: [], access: [], incidents: [], vulns: [] } });
    expect(empty).toContain("## Shipped\n\nNothing.");
    expect(empty).toContain("## Risks\n\nNone.");
    expect(empty).toContain("## Asks\n\nNone.");
    expect(empty).toContain("## Compliance\n\nNothing to report.");
  });

  it("flattens a model's text to one safe line, so no heading, mention, issue link or table cell can come out of it", () => {
    const hostile = statusPage("2026-W46", { ...answer, headline: "Done\n## Asks\n- pay me @everyone see #12", summary: "line one\n## Facts\nline two", risks: ["a | b\nc"] }, facts);
    expect(hostile.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(9);
    expect(hostile).not.toContain("@everyone");
  });
});

describe("summaryOf", () => {
  it("is the Summary section of a page: the text between its heading and the next one", () => {
    expect(summaryOf(statusPage("2026-W46", answer, facts))).toBe("Seven shipped. Auth slips.");
  });
  it("is the whole text of a page that has no such heading", () => {
    expect(summaryOf("just a text")).toBe("just a text");
  });
  it("is what an edited page keeps: a person may rewrite the summary", () => {
    expect(summaryOf("# Status\n\n## Summary\n\nEdited.\nTwo lines.\n\n## Headline\n\nx\n")).toBe("Edited.\nTwo lines.");
  });
});
