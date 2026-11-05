import { TICKET_CAPS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { GhIssue } from "../application/github.ts";
import type { JiraIssue } from "../application/jira.ts";
import { canonicalTicketOf } from "./ticket.ts";

const jiraIssue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "PAY-12",
  url: "https://acme.atlassian.net/browse/PAY-12",
  summary: "Refund   fails\nfor  EU",
  description: "Steps:\n1. pay\n2. refund",
  status: "To Do",
  statusCategory: "new",
  issueType: "Bug",
  priority: "High",
  dueAt: "2026-12-01",
  labels: ["team-payments"],
  updated: "2026-11-01T10:00:00.000+0000",
  reporter: { id: "acc-1", name: "Ana" },
  comments: [{ author: "Bo", authorId: "acc-2", text: "seen it too", created: "2026-11-02T10:00:00.000+0000" }],
  ...over,
});

describe("canonicalTicketOf", () => {
  it("builds a ticket from a Jira issue, the title on one line", () => {
    const t = canonicalTicketOf({ tool: "jira", issue: jiraIssue() });
    expect(t).toMatchObject({ tool: "jira", id: "PAY-12", key: "PAY-12", title: "Refund fails for EU", type: "Bug", priority: "High", dueAt: "2026-12-01", permalink: "https://acme.atlassian.net/browse/PAY-12" });
    expect(t.reporter).toEqual({ id: "acc-1", name: "Ana" });
    expect(t.comments).toEqual([{ author: "Bo", text: "seen it too", at: "2026-11-02T10:00:00.000+0000" }]);
    expect(t.description).toContain("1. pay");
  });

  it("builds a ticket from a GitHub issue, keyed by repository and number", () => {
    const issue: GhIssue = { number: 7, title: "Crash on start", body: "stack", url: "https://github.com/o/r/issues/7", labels: ["bug"], author: "ana" };
    const t = canonicalTicketOf({ tool: "github", slug: "o/r", issue });
    expect(t).toMatchObject({ tool: "github", id: "o/r#7", key: "o/r#7", title: "Crash on start", labels: ["bug"], reporter: { id: "ana", name: "ana" }, assignee: null, status: "open" });
  });

  it("caps every text and bounds every list", () => {
    const long = "x".repeat(TICKET_CAPS.description * 2);
    const t = canonicalTicketOf({
      tool: "jira",
      issue: jiraIssue({
        summary: "t".repeat(1000),
        description: long,
        labels: Array.from({ length: 100 }, (_, i) => `l${i}`),
        comments: Array.from({ length: 100 }, () => ({ author: "a", authorId: null, text: long, created: "2026-11-02" })),
      }),
    });
    expect(t.title.length).toBeLessThanOrEqual(TICKET_CAPS.title);
    expect(t.description.length).toBeLessThanOrEqual(TICKET_CAPS.description);
    expect(t.labels).toHaveLength(TICKET_CAPS.labels);
    expect(t.comments).toHaveLength(TICKET_CAPS.comments);
    expect(t.comments[0]!.text.length).toBeLessThanOrEqual(TICKET_CAPS.commentText);
  });

  it("redacts a token-shaped string in any text", () => {
    const secret = ["gh", "p_"].join("") + "a".repeat(36);
    const t = canonicalTicketOf({ tool: "jira", issue: jiraIssue({ description: `use ${secret} here` }) });
    expect(t.description).not.toContain(secret);
  });
});
