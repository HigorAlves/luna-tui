import { describe, expect, it } from "vitest";

import { CanonicalTicket, TICKET_CAPS } from "./ticket.ts";

const base = {
  tool: "jira",
  id: "PAY-12",
  key: "PAY-12",
  title: "Refund fails",
  description: "It fails.",
  type: "Bug",
  status: "To Do",
  priority: "High",
  reporter: { id: "u1", name: "Ana" },
  assignee: "bo",
  labels: ["team-payments"],
  components: ["payments"],
  links: { blocks: [], duplicates: [], epic: null },
  comments: [],
  attachments: [],
  sprint: null,
  dueAt: null,
  createdAt: null,
  updatedAt: null,
  permalink: "https://acme.atlassian.net/browse/PAY-12",
};

describe("the canonical ticket", () => {
  it("accepts a ticket from either tool", () => {
    expect(CanonicalTicket.safeParse(base).success).toBe(true);
    expect(CanonicalTicket.safeParse({ ...base, tool: "github", id: "o/r#3", key: "o/r#3" }).success).toBe(true);
    expect(CanonicalTicket.safeParse({ ...base, tool: "linear" }).success).toBe(false);
  });

  it("bounds every list and every text", () => {
    expect(CanonicalTicket.safeParse({ ...base, labels: Array(TICKET_CAPS.labels + 1).fill("x") }).success).toBe(false);
    expect(CanonicalTicket.safeParse({ ...base, title: "x".repeat(TICKET_CAPS.title + 1) }).success).toBe(false);
    expect(CanonicalTicket.safeParse({ ...base, comments: Array(TICKET_CAPS.comments + 1).fill({ author: "a", text: "t", at: null }) }).success).toBe(false);
  });
});
