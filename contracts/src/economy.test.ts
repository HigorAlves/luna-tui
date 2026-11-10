import { describe, expect, it } from "vitest";

import { EconomyInput, EconomyStatus, FACTS_HEADER, LOOP_STUCK, Observation, access, effectiveTokens, narrow } from "./index.ts";

describe("economy", () => {
  it("weights tokens as they are billed: cache reads a tenth, cache writes above input, output five times", () => {
    // 1000 input holds the 400 written to the cache: 600 new + 400 × 1.25 + 5000 × 0.1 + 100 × 5.
    expect(effectiveTokens({ input: 1000, output: 100, cached: 5000, cacheWrite5m: 400 })).toBe(2100);
    expect(effectiveTokens({ input: 1000, output: 0, cached: 0, cacheWrite1h: 1000 })).toBe(2000);
    expect(effectiveTokens({ input: 10, output: 2, cached: 0 })).toBe(20);
  });

  it("narrows an access by a mask: the units the mask names are removed and nothing is added", () => {
    const pack = access({ read: true, web: true, agent: true, skills: true, commands: ["npm"], luna: ["step", "card_search"] });
    const narrowed = narrow(pack, { web: true, agent: true, skills: ["code-discovery"], luna: ["card_search"] }, ["code-discovery", "tdd"]);
    expect(narrowed.access).toEqual({ ...pack, web: false, agent: false, luna: ["step"] });
    expect(narrowed.skills).toEqual(["tdd"]);
    expect(narrow(pack, undefined, ["tdd"])).toEqual({ access: pack, skills: ["tdd"] });
  });

  it("a mask that names every skill of the pack turns the skills off", () => {
    const pack = access({ read: true, skills: true });
    expect(narrow(pack, { skills: ["tdd"] }, ["tdd"])).toEqual({ access: { ...pack, skills: false }, skills: [] });
  });

  it("a mask never removes a luna tool the machine relies on", () => {
    const pack = access({ luna: ["step", "slice_set", "decision_get", "scope_check", "scenario_red", "card_search"] });
    const masked = narrow(pack, { luna: ["step", "slice_set", "decision_get", "scope_check", "scenario_red"] }, []);
    expect(masked.access.luna).toEqual(pack.luna);
  });

  it("an observation carries the class of a result and never its text", () => {
    expect(Observation.parse({ intent: "test", form: "pytest -q", errorClass: "command_not_found", failure: "a1b2c3d4e5", edits: ["src/a.ts"] })).toBeTruthy();
    expect(Observation.safeParse({ form: "x".repeat(121) }).success).toBe(false);
    expect(Observation.safeParse({ output: "anything" }).success).toBe(false);
  });

  it("a stage's economy input holds the guard, the facts and the mask, each optional", () => {
    expect(EconomyInput.parse({})).toEqual({});
    const guard = { mode: "record", judge: true, envelope: null, judgeConfidence: 0.7, redirects: 1, backstopMult: 2.5 };
    expect(EconomyInput.parse({ guard, facts: ["use `python -m pytest`: `pytest` is not on PATH here"], mask: { web: true } }).guard).toEqual(guard);
    expect(EconomyInput.safeParse({ facts: Array(9).fill("f") }).success).toBe(false);
  });

  it("a run's facts open under one header line the factory and the machine share", () => {
    expect(FACTS_HEADER).toBe("# environment facts learned from earlier sessions in this repository");
  });

  it("the status lists each fact with its state and its counts, and refuses a fact that is not one", () => {
    const base = { envelopes: {}, guard: [], cost: { exec: 0, overhead: 0, overheadShare: 0 } };
    const fact = { id: "a1b2c3d4e5f6", family: "form_repair", source: "free", state: "active", text: "`pytest …` fails here with command not found; `python -m pytest …` works.", confirmations: 3, contradictions: 0, exercised: 4, fired: 2 };
    expect(EconomyStatus.parse({ ...base, facts: [fact] }).facts).toEqual([fact]);
    expect(EconomyStatus.safeParse({ ...base, facts: [{ ...fact, state: "bogus" }] }).success).toBe(false);
    expect(EconomyStatus.safeParse({ ...base, facts: [{ id: "x" }] }).success).toBe(false);
  });

  it("names the error a stopped run starts with", () => {
    expect(LOOP_STUCK).toBe("the loop guard stopped the run");
  });
});
