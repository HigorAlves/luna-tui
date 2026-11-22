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
  it("counts the ui-designer's helper runs by their build.helper_ended rows, with the other designer runs", () => {
    const ended = (tokens: number | null, minutes: number) => ({ kind: "build.helper_ended", payload: { slice: 2, attempt: 1, outcome: "pass", tokens, minutes } });
    expect(designBudget([ran(300_000, 6), ended(400_000, 10)], limits)).toMatchObject({ tokens: 700_000, minutes: 16, minutesLeft: 29, spent: null });
    expect(designBudget([ended(1_000_001, 1)], limits).spent).toBe("tokens");
    expect(designBudget([ended(5, 50)], limits)).toMatchObject({ spent: "minutes", minutesLeft: 0 });
  });
  it("never counts a helper's row a container wrote under the machine's kind, nor one with bent numbers", () => {
    expect(designBudget([{ kind: "stage.build.helper_ended", payload: { tokens: 9_999_999, minutes: 99 } }], limits)).toMatchObject({ tokens: null, minutes: 0, spent: null });
    expect(designBudget([{ kind: "build.helper_ended", payload: { tokens: -4, minutes: -3 } }], limits)).toMatchObject({ tokens: null, minutes: 0 });
  });
});
