import { describe, expect, it } from "vitest";

import { renderDedup } from "./decide.ts";

describe("what intake_dedup reads", () => {
  it("shows the new card and each candidate by slot, as data", () => {
    const text = renderDedup({ title: "Checkout fails", text: "pay button dead", candidates: [{ slot: 1, kind: "open", title: "Pay broken", summary: "button does nothing" }, { slot: 2, kind: "backlog", title: "Slow page", summary: "" }] });
    expect(text).toContain("New report: Checkout fails");
    expect(text).toContain("pay button dead");
    expect(text).toContain("slot1 (open card): Pay broken");
    expect(text).toContain("slot2 (backlog item): Slow page");
  });
});
