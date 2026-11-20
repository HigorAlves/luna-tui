import { describe, expect, it } from "vitest";

import { designBudget } from "./design-budget.ts";

const limits = { max_tokens: 1_000_000, max_minutes: 45 };
const ran = (tokens: number | null, minutes: number, pack = "design_spec") => ({ kind: "design.run", payload: { pack, tokens, minutes, outcome: "pass" } });

describe("designBudget", () => {
  it("sums the designer runs' tokens and minutes", () => {
    expect(designBudget([ran(300_000, 6), ran(250_000, 12, "a11y_audit"), { kind: "stage.finished", payload: {} }], limits)).toMatchObject({ tokens: 550_000, tokensCounted: true, minutes: 18, spent: null });
  });
  it("is spent on tokens past the limit, then on minutes past it, naming which", () => {
    expect(designBudget([ran(1_000_001, 1)], limits).spent).toBe("tokens");
    expect(designBudget([ran(10, 46)], limits).spent).toBe("minutes");
  });
  it("counts tokens only when a run reported them, and never spends the token limit then", () => {
    expect(designBudget([ran(null, 5)], limits)).toMatchObject({ tokens: null, tokensCounted: false, spent: null });
  });
  it("counts from the last design.budget_reset", () => {
    const rows = [ran(900_000, 40), { kind: "design.budget_reset", payload: { reason: "a person approved" } }, ran(200_000, 5)];
    expect(designBudget(rows, limits)).toMatchObject({ tokens: 200_000, minutes: 5, spent: null });
  });
  it("ignores a row whose numbers a container could have bent: negative or fractional tokens", () => {
    expect(designBudget([ran(-5, 1), { kind: "design.run", payload: { pack: "design_spec", tokens: 1.5, minutes: 1 } }], limits).tokens).toBeNull();
  });
});
