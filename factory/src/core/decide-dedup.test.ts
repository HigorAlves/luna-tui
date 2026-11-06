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
