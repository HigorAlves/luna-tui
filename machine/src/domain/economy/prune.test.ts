import { PACKS, type EconomyConfig } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type PackTools, approve, emptyTools, foldTools, maskOf, proposalOf, restoreUnit, unitsOf, usedUnits } from "./prune.ts";

const cfg: EconomyConfig["prune"] = { runs: 10, min_cards: 2, cards: 5 };
const call = (tool: string, target = "", allowed = true) => ({ kind: "tool_call", payload: { tool, target, allowed } });

const UNITS = ["web", "agent", "skill:tdd", "luna:card_search"];
/** `n` runs that used nothing, on the given cards (cycled). */
const idle = (state: PackTools, n: number, cards: string[], used: string[] = []): PackTools => {
  let now = state;
  for (let i = 0; i < n; i++) now = foldTools(now, { units: UNITS, used: new Set(used), cardId: cards[i % cards.length]!, prune: cfg });
  return now;
};

describe("unitsOf", () => {
  it("names web, agent, each skill and each luna tool that is not protected", () => {
    const pack = PACKS.triage;
    const units = unitsOf(pack);
    expect(units).toContain("web");
    expect(units).toContain("agent");
    expect(units).toContain("luna:card_search");
    expect(units).toContain("skill:code-discovery");
    expect(units).not.toContain("luna:decision_get");
    expect(units).not.toContain("luna:step");
  });

  it("names only what the pack has, and nothing for a pack without an agent", () => {
    expect(unitsOf(PACKS.build_tests)).toEqual(["skill:tdd", "skill:code-discovery"]);
    expect(unitsOf(PACKS.triage_signals)).toEqual([]);
  });
});

describe("usedUnits", () => {
  it("reads the units out of allowed calls, Claude and eve names alike", () => {
    const used = usedUnits([call("WebFetch"), call("web_fetch"), call("Agent"), call("Skill", "luna-factory:tdd"), call("mcp__luna__card_search"), call("card_search"), call("Read"), call("Bash")]);
    expect([...used].sort()).toEqual(["agent", "luna:card_search", "skill:tdd", "web"]);
  });

  it("does not count a refused call as a use", () => {
    expect(usedUnits([call("WebFetch", "x", false), call("Skill", "tdd", false)]).size).toBe(0);
  });
});

describe("foldTools and proposalOf", () => {
  it("proposes a unit unused over ten runs across two cards", () => {
    const state = idle(emptyTools(), 10, ["a", "b"]);
    expect(state.proposal.sort()).toEqual([...UNITS].sort());
  });

  it("waits while the runs are all on one card", () => {
    expect(idle(emptyTools(), 10, ["a"]).proposal).toEqual([]);
  });

  it("proposes after five distinct cards even with fewer than ten runs", () => {
    expect(idle(emptyTools(), 4, ["a", "b", "c", "d"]).proposal).toEqual([]);
    expect(idle(emptyTools(), 5, ["a", "b", "c", "d", "e"]).proposal).toHaveLength(UNITS.length);
  });

  it("one use ever removes the unit from every later proposal", () => {
    let state = idle(emptyTools(), 9, ["a", "b"]);
    state = foldTools(state, { units: UNITS, used: new Set(["web"]), cardId: "a", prune: cfg });
    state = idle(state, 30, ["a", "b", "c", "d", "e", "f"]);
    expect(state.proposal).not.toContain("web");
    expect(state.proposal).toContain("agent");
  });

  it("gathers no evidence for a masked unit", () => {
    let state = idle(emptyTools(), 10, ["a", "b"]);
    state = approve(state);
    const before = state.units.web!;
    state = idle(state, 5, ["c"]);
    expect(state.units.web).toEqual(before);
    expect(state.proposal).toEqual([]);
  });

  it("proposalOf reads the thresholds it is given", () => {
    const state = idle(emptyTools(), 3, ["a", "b"]);
    expect(proposalOf(state, { runs: 3, min_cards: 2, cards: 5 })).toHaveLength(UNITS.length);
    expect(proposalOf(state, { runs: 4, min_cards: 2, cards: 5 })).toEqual([]);
  });
});

describe("approve, restoreUnit and maskOf", () => {
  it("turns the proposal into the mask", () => {
    const state = approve(idle(emptyTools(), 10, ["a", "b"]));
    expect(state.proposal).toEqual([]);
    expect(maskOf(state)).toEqual({ web: true, agent: true, skills: ["tdd"], luna: ["card_search"] });
  });

  it("an empty proposal approves to the same state", () => {
    const state = emptyTools();
    expect(approve(state)).toEqual(state);
    expect(maskOf(state)).toEqual({});
  });

  it("restore takes the unit out of the mask and never proposes it again", () => {
    let state = approve(idle(emptyTools(), 10, ["a", "b"]));
    state = restoreUnit(state, "web");
    expect(maskOf(state).web).toBeUndefined();
    expect(state.units.web!.kept).toBe(true);
    state = idle(state, 40, ["a", "b", "c", "d", "e", "f"]);
    expect(state.proposal).not.toContain("web");
  });

  it("restore takes a proposed unit out of the proposal too", () => {
    const state = restoreUnit(idle(emptyTools(), 10, ["a", "b"]), "agent");
    expect(state.proposal).not.toContain("agent");
  });
});
