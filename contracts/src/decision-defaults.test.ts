import { describe, expect, it } from "vitest";

import { DECISION_ALLOWED, DECISION_DEFAULTS, DecisionDefault, DecisionDefaults, PACKS, decisionEngines } from "./index.ts";

const decisionPacks = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);

describe("decision-defaults.json", () => {
  it("has an entry for every decision pack and none for anything else", () => {
    expect(Object.keys(DECISION_DEFAULTS).sort()).toEqual([...decisionPacks].sort());
  });

  it("is valid: each default and fallback is an allowed engine, each entry has a reason and a date", () => {
    expect(DecisionDefaults.safeParse(DECISION_DEFAULTS).error?.issues ?? []).toEqual([]);
    for (const pack of decisionPacks) {
      const entry = DecisionDefault.parse(DECISION_DEFAULTS[pack]);
      for (const engine of [entry.default, ...entry.fallback]) expect(DECISION_ALLOWED, `${pack}: ${engine}`).toContain(engine);
      expect(entry.reason.length, pack).toBeGreaterThan(0);
      expect(entry.measuredAt, pack).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("refuses an engine outside `allowed`, a fallback that names the default, and an entry with no reason or date", () => {
    const ok = { default: "jev", fallback: ["claude:haiku"], reason: "r", measuredAt: "2026-11-04" };
    expect(DecisionDefault.safeParse(ok).success).toBe(true);
    expect(DecisionDefault.safeParse({ ...ok, default: "claude:opus" }).success).toBe(false);
    expect(DecisionDefault.safeParse({ ...ok, fallback: ["openai:sol"] }).success).toBe(false);
    expect(DecisionDefault.safeParse({ ...ok, fallback: ["jev"] }).success).toBe(false);
    expect(DecisionDefault.safeParse({ ...ok, reason: "" }).success).toBe(false);
    expect(DecisionDefault.safeParse({ ...ok, measuredAt: "yesterday" }).success).toBe(false);
  });

  it("is what the packs run on: the file's default and fallback, with `allowed` unchanged", () => {
    expect(decisionEngines("event_class").default).toBe(DecisionDefault.parse(DECISION_DEFAULTS.event_class).default);
    for (const pack of decisionPacks) {
      expect(PACKS[pack as "event_class"].engines).toEqual(decisionEngines(pack));
      expect(PACKS[pack as "event_class"].engines.allowed).toEqual(["jev", "claude:haiku", "codex:luna"]);
    }
  });

  it("falls back to the built-in default for an entry it cannot trust, rather than failing", () => {
    expect(decisionEngines("not_a_pack")).toEqual({ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] });
  });
});
