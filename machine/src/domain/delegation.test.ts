import { type EngineId, type Ledger, type Slice, stepsOfAnswer } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type DelegationFacts, IMPLEMENTER_RESERVE_MINUTES, MIN_HELPER_MINUTES, delegable, helperMinutes, isUiSlice, locksOf } from "./delegation.ts";

const plan: Slice[] = stepsOfAnswer([
  { title: "API", description: "API", est_loc: 20, files: ["src/api/card.ts", "src/api/card.test.ts"], done_when: ["a"] },
  { title: "Card", description: "Card", est_loc: 40, files: ["src/ui/Card.tsx", "src/ui/Card.test.tsx"], done_when: ["shows the title"] },
  { title: "Page", description: "Page", est_loc: 30, files: ["src/ui/Page.tsx", "src/ui/Card.css"], done_when: ["b"] },
]).slices;

const ledgerOf = (statuses: Array<"pending" | "red" | "green" | "committed" | "escalated"> = ["pending", "pending", "pending"]): Ledger => ({
  schema: 1,
  slices: statuses.map((status, i) => ({ id: i + 1, title: plan[i]!.title, status, commit: status === "committed" ? "abc1234" : null })),
});

const facts = (over: Partial<DelegationFacts> = {}): DelegationFacts => ({
  slices: plan,
  ledger: ledgerOf(),
  sliceId: 2,
  webRoots: [],
  designRef: { refs: [{ fileKey: "AbCdEf0123456789", nodeIds: ["1:2"], page: null, from: "issue" }] },
  designOff: false,
  active: null,
  attempted: new Set<number>(),
  designBudget: { spent: false, minutesLeft: 30 },
  implementerMinutesLeft: 25,
  implementerEngine: "claude:sonnet" as EngineId,
  repoEngine: null,
  claudeAvailable: true,
  ...over,
});

describe("isUiSlice", () => {
  it("is true when every planned file that is not a test renders", () => {
    expect(isUiSlice(["src/ui/Card.tsx", "src/ui/Card.test.tsx"], [])).toBe(true);
  });
  it("is false with a file that does not render, or a manifest or a lockfile (D2)", () => {
    expect(isUiSlice(["src/ui/Card.tsx", "src/api/card.ts"], [])).toBe(false);
    expect(isUiSlice(["src/ui/Card.tsx", "package.json"], [])).toBe(false);
    expect(isUiSlice(["src/ui/Card.tsx", "pnpm-lock.yaml"], [])).toBe(false);
    expect(isUiSlice(["src/ui/Card.tsx", "Cargo.toml"], [])).toBe(false);
    expect(isUiSlice(["src/ui/Card.tsx", "app/go.mod"], [])).toBe(false);
    expect(isUiSlice(["src/ui/Card.tsx", "yarn.lock"], [])).toBe(false);
  });
  it("is false for a slice with no file, or only tests", () => {
    expect(isUiSlice([], [])).toBe(false);
    expect(isUiSlice(["src/ui/Card.test.tsx"], [])).toBe(false);
  });
  it("counts a source under a web package's src/ as rendering", () => {
    expect(isUiSlice(["apps/web/src/cart.ts"], ["apps/web"])).toBe(true);
    expect(isUiSlice(["apps/api/src/cart.ts"], ["apps/web"])).toBe(false);
  });
});

describe("locksOf", () => {
  it("gives the helper its slice's files and the implementer the files of every other slice still open", () => {
    expect(locksOf(plan, 3)).toEqual({ helper: plan[2]!.touchpoints, implementer: [...plan[0]!.touchpoints, ...plan[1]!.touchpoints] });
  });
  it("leaves out the files of a slice already committed: the implementer locks nothing it has finished", () => {
    expect(locksOf(plan, 3, ledgerOf(["committed", "pending", "pending"]))).toEqual({ helper: plan[2]!.touchpoints, implementer: plan[1]!.touchpoints });
  });
  it("lists a shared file once", () => {
    const shared = [{ ...plan[0]!, touchpoints: ["a.ts", "b.ts"] }, { ...plan[1]!, touchpoints: ["b.ts", "c.tsx"] }];
    expect(locksOf(shared, 2).implementer).toEqual(["a.ts", "b.ts"]);
  });
});

describe("delegable", () => {
  it("accepts a pure UI slice and returns the engine and the locks", () => {
    expect(delegable(facts())).toEqual({ ok: true, engine: "claude:sonnet", locks: locksOf(plan, 2) });
  });
  it("refuses an unknown slice", () => {
    expect(delegable(facts({ sliceId: 9 }))).toEqual({ ok: false, reason: "slice 9 is not in the plan" });
    expect(delegable(facts({ sliceId: 0 }))).toEqual({ ok: false, reason: "slice 0 is not in the plan" });
    expect(delegable(facts({ ledger: { schema: 1, slices: [] } }))).toEqual({ ok: false, reason: "slice 2 is not in the ledger" });
  });
  it("refuses a slice that is not pending", () => {
    expect(delegable(facts({ ledger: ledgerOf(["pending", "red", "pending"]) }))).toEqual({ ok: false, reason: "slice 2 is red, and only a pending slice can go to the ui-designer" });
  });
  it("refuses a slice that is not a pure UI slice, and says build it yourself", () => {
    expect(delegable(facts({ sliceId: 1 }))).toEqual({ ok: false, reason: "slice 1 is not a pure UI slice: a planned file does not render, or is a manifest or a test only; build it yourself" });
  });
  it("refuses a slice that shares a planned file with another open slice, naming the files (D3)", () => {
    const shared = [plan[0]!, { ...plan[1]!, touchpoints: ["src/ui/Card.tsx", "src/ui/index.ts"] }, { ...plan[2]!, touchpoints: ["src/ui/index.ts", "src/ui/Page.tsx"] }];
    expect(delegable(facts({ slices: shared }))).toEqual({ ok: false, reason: "slice 2 shares src/ui/index.ts with slice 3; build it yourself, or do the shared edit first" });
  });
  it("lets a slice share a file with a slice that is already committed", () => {
    const shared = [{ ...plan[0]!, touchpoints: ["src/ui/index.ts"] }, { ...plan[1]!, touchpoints: ["src/ui/Card.tsx", "src/ui/index.ts"] }, plan[2]!];
    expect(delegable(facts({ slices: shared, ledger: ledgerOf(["committed", "pending", "pending"]) })).ok).toBe(true);
  });
  it("refuses with no design reference (D9), and with design off", () => {
    expect(delegable(facts({ designRef: null }))).toEqual({ ok: false, reason: "the card has no design reference: build the slice yourself" });
    expect(delegable(facts({ designOff: true }))).toEqual({ ok: false, reason: "the designer agents are off for this card: build the slice yourself" });
  });
  it("refuses a second helper while one is running", () => {
    expect(delegable(facts({ active: { slice: 3 } }))).toEqual({ ok: false, reason: "the ui-designer is already building slice 3; call slice_wait, then delegate again" });
  });
  it("refuses a second helper attempt on the same slice", () => {
    expect(delegable(facts({ attempted: new Set([2]) }))).toEqual({ ok: false, reason: "the ui-designer already had slice 2 once: build it yourself" });
  });
  it("refuses when the design budget is spent", () => {
    expect(delegable(facts({ designBudget: { spent: true, minutesLeft: 30 } }))).toEqual({ ok: false, reason: "the design budget is spent: build the slice yourself" });
  });
  it(`refuses when the helper would get less than ${MIN_HELPER_MINUTES} minutes: the smaller of the design budget's and the run's minus ${IMPLEMENTER_RESERVE_MINUTES}`, () => {
    expect(MIN_HELPER_MINUTES).toBe(8);
    expect(IMPLEMENTER_RESERVE_MINUTES).toBe(3);
    expect(helperMinutes(30, 25)).toBe(22);
    expect(helperMinutes(5, 25)).toBe(5);
    expect(delegable(facts({ implementerMinutesLeft: 10 }))).toEqual({ ok: false, reason: "less than 8 minutes would be left for the helper once the implementer keeps 3 of this run's: build the slice yourself" });
    expect(delegable(facts({ designBudget: { spent: false, minutesLeft: 7.5 } }))).toEqual({ ok: false, reason: "less than 8 minutes are left of the design budget: build the slice yourself" });
    expect(delegable(facts({ implementerMinutesLeft: 11, designBudget: { spent: false, minutesLeft: 8 } })).ok).toBe(true);
  });
  it("uses the repo's engine for the helper when luna.yaml names one", () => {
    expect(delegable(facts({ repoEngine: "claude:opus" }))).toMatchObject({ ok: true, engine: "claude:opus" });
  });
  it("moves the helper to Claude when both would hold the Codex login (D6), and refuses with no Claude credential", () => {
    const both = { implementerEngine: "codex:sol" as EngineId, repoEngine: "codex:luna" as EngineId };
    expect(delegable(facts(both))).toMatchObject({ ok: true, engine: "claude:sonnet" });
    expect(delegable(facts({ ...both, claudeAvailable: false }))).toEqual({ ok: false, reason: "the implementer and the ui-designer would both need the Codex login, and no Claude credential is set: build the slice yourself" });
  });
  it("keeps a Codex helper when the implementer runs on Claude", () => {
    expect(delegable(facts({ repoEngine: "codex:sol" }))).toMatchObject({ ok: true, engine: "codex:sol" });
  });
});
