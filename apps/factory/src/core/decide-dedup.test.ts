import { describe, expect, it } from "vitest";

import { renderDedup, renderTicket } from "./decide.ts";

describe("what intake_dedup reads", () => {
  it("shows the new card and each candidate by slot, as data", () => {
    const text = renderDedup({ title: "Checkout fails", text: "pay button dead", candidates: [{ slot: 1, kind: "open", title: "Pay broken", summary: "button does nothing" }, { slot: 2, kind: "backlog", title: "Slow page", summary: "" }] });
    expect(text).toContain("New report: Checkout fails");
    expect(text).toContain("pay button dead");
    expect(text).toContain("slot1 (open card): Pay broken");
    expect(text).toContain("slot2 (backlog item): Slow page");
  });
});

describe("what pr_link reads", () => {
  it("shows the PR and each candidate by slot with its kind, as data written by strangers", async () => {
    const { renderPrLink, stateOf } = await import("./decide.ts");
    const prLink = {
      pr: { title: "Export CSV", branch: "feat/export", body: "Adds the export.", files: ["src/export.ts", "src/export.test.ts"] },
      candidates: [
        { slot: 1, kind: "jira" as const, id: "DISC-12", title: "Export to CSV", excerpt: "Users want a CSV." },
        { slot: 2, kind: "card" as const, id: "7f3c9a1e", title: "Pay button", excerpt: "" },
      ],
    };
    const text = renderPrLink(prLink);
    expect(text).toContain("data written by strangers");
    expect(text).toContain("Pull request: Export CSV");
    expect(text).toContain("Branch: feat/export");
    expect(text).toContain("Adds the export.");
    expect(text).toContain("src/export.ts, src/export.test.ts");
    expect(text).toContain("slot1 (Jira ticket DISC-12): Export to CSV | Users want a CSV.");
    expect(text).toContain("slot2 (board card 7f3c9a1e): Pay button");
    const input = { schema: 3, stage: "pr_link", pack: "pr_link", attempt: 1, task: { id: "pr-link", title: "Export CSV", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null, prLink }, limits: { maxTurns: 1, timeoutMs: 60000 }, env: {} };
    expect(stateOf(input as never)).toEqual({ title: "Pull request: Export CSV", description: text });
  });
});

describe("what ticket_validity reads", () => {
  it("shows the ticket and its enrichment as data written by strangers", () => {
    const text = renderTicket({ key: "PAY-12", title: "Refund fails", description: "it throws", type: "Bug", priority: "High", reporter: "Ana", reachable: true, labels: ["eu"], sprint: null, dueAt: null, comments: [{ author: "Bo", text: "seen" }], linked: ["PAY-30"], epic: "PAY-1", recent: [{ key: "PAY-9", title: "Rounding" }], files: ["src/a.ts"], candidates: [{ slot: 1, kind: "open", title: "Pay broken", summary: "s" }] });
    expect(text).toContain("data written by strangers");
    expect(text).toContain("Ticket PAY-12: Refund fails");
    expect(text).toContain("Bo: seen");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("slot1 (open card): Pay broken");
  });
});
