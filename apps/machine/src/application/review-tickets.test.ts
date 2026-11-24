import { describe, expect, it } from "vitest";

import { fakeJira } from "../test/jira.ts";
import { MAX_REVIEW_TICKETS, TICKET_DESCRIPTION_CAP, acceptanceCriteriaOf, findPrJiraKeys, gatherTickets } from "./review-tickets.ts";

const pr = (over: Partial<{ title: string; headRef: string; body: string | null }> = {}) => ({ title: "Export CSV", headRef: "feat/export", body: null, ...over });

describe("findPrJiraKeys", () => {
  it("reads the key off the title, the head branch and the body, in that order, once each", () => {
    expect(findPrJiraKeys(pr({ title: "fix(cycles): stale feedback (DISC-939)" }))).toEqual(["DISC-939"]);
    expect(findPrJiraKeys(pr({ headRef: "bugfix/DISC-12-stale-feedback" }))).toEqual(["DISC-12"]);
    expect(findPrJiraKeys(pr({ body: "Closes PLAT-7.\nSee also https://acme.atlassian.net/browse/DISC-3" }))).toEqual(["PLAT-7", "DISC-3"]);
    expect(findPrJiraKeys(pr({ title: "DISC-1 a", headRef: "DISC-2-a", body: "DISC-2 and DISC-1 and DISC-3" }))).toEqual(["DISC-1", "DISC-2", "DISC-3"]);
  });

  it("keeps at most three", () => {
    expect(MAX_REVIEW_TICKETS).toBe(3);
    expect(findPrJiraKeys(pr({ body: "AB-1 BC-2 CD-3 DE-4 EF-5" }))).toEqual(["AB-1", "BC-2", "CD-3"]);
  });

  it("ignores what is not an issue: standards, encodings, hashes", () => {
    expect(findPrJiraKeys(pr({ body: "Uses UTF-8, ISO-8601 dates and SHA-256, see RFC-2119 and CVE-2024-1234" }))).toEqual([]);
    expect(findPrJiraKeys(pr({ title: "lowercase disc-939 is not a key", body: "XDISC-939x_ nor 939-DISC" }))).toEqual([]);
  });

  it("with the projects the machine knows, keeps only those", () => {
    const body = "ZZZ-1, DISC-2 and PLAT-3";
    expect(findPrJiraKeys(pr({ body }), ["DISC"])).toEqual(["DISC-2"]);
    expect(findPrJiraKeys(pr({ body }), [])).toEqual(["ZZZ-1", "DISC-2", "PLAT-3"]);
  });
});

describe("acceptanceCriteriaOf", () => {
  it("takes the section under an Acceptance Criteria heading up to the next heading", () => {
    const text = "Why\n\nWe need it.\n\n## Acceptance criteria\n\n- exports a CSV\n- keeps the order\n\n## Notes\n\nLater.";
    expect(acceptanceCriteriaOf(text)).toBe("- exports a CSV\n- keeps the order");
  });

  it("takes a bold or plain label line, and an inline label", () => {
    expect(acceptanceCriteriaOf("Intro\n\n**Acceptance Criteria:**\n- a\n- b")).toBe("- a\n- b");
    expect(acceptanceCriteriaOf("Acceptance criteria\n1. one")).toBe("1. one");
    expect(acceptanceCriteriaOf("Acceptance criteria: it exports.")).toBe("it exports.");
  });

  it("is null when the description has none, or the section is empty", () => {
    expect(acceptanceCriteriaOf("Just a description.")).toBeNull();
    expect(acceptanceCriteriaOf("## Acceptance criteria\n\n## Notes\nx")).toBeNull();
    expect(acceptanceCriteriaOf("")).toBeNull();
  });
});

describe("gatherTickets", () => {
  const issues = [
    { key: "DISC-939", summary: "Stale feedback", issueType: "Bug", status: "In Review", description: "Body.\n\n## Acceptance criteria\n- removes rows" },
    { key: "DISC-12", summary: "Other", issueType: "Story", status: null, description: "x".repeat(TICKET_DESCRIPTION_CAP + 500) },
  ];

  it("maps each issue the PR names into a ticket", async () => {
    const jira = fakeJira({ issues });
    const tickets = await gatherTickets({ jira }, pr({ title: "fix (DISC-939)", body: "also DISC-12" }));
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toEqual({
      key: "DISC-939",
      url: "https://acme.atlassian.net/browse/DISC-939",
      type: "Bug",
      status: "In Review",
      summary: "Stale feedback",
      description: "Body.\n\n## Acceptance criteria\n- removes rows",
      acceptanceCriteria: "- removes rows",
    });
    expect(tickets[1]).toMatchObject({ key: "DISC-12", type: "Story", status: "Unknown", acceptanceCriteria: null });
    expect(tickets[1]!.description.length).toBeLessThanOrEqual(TICKET_DESCRIPTION_CAP + 40);
    expect(tickets[1]!.description).toContain("[cut");
  });

  it("skips a ticket that fails or is missing, with a log line, and keeps the rest", async () => {
    const lines: string[] = [];
    const jira = fakeJira({ issues });
    const tickets = await gatherTickets({ jira, log: (l) => lines.push(l) }, pr({ title: "NOPE-1 DISC-939" }));
    expect(tickets.map((t) => t.key)).toEqual(["DISC-939"]);
    expect(lines.join("\n")).toMatch(/NOPE-1/);
    const broken = fakeJira({ issues, failing: { issue: new Error("boom") } });
    expect(await gatherTickets({ jira: broken, log: () => {} }, pr({ title: "DISC-939" }))).toEqual([]);
  });

  it("gives nothing without a Jira port or a key, and asks the repo's projects when it can", async () => {
    expect(await gatherTickets({}, pr({ title: "DISC-939" }))).toEqual([]);
    expect(await gatherTickets({ jira: fakeJira({ issues }) }, pr())).toEqual([]);
    const jira = fakeJira({ issues });
    const tickets = await gatherTickets({ jira, projects: async () => ["PLAT"] }, pr({ title: "DISC-939" }));
    expect(tickets).toEqual([]);
  });
});
