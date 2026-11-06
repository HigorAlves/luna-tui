import { describe, expect, it, vi } from "vitest";

import { DECISION_ALLOWED, DECISION_DEFAULTS, DecisionDefault, DecisionDefaults, PACKS, decisionEngines } from "./index.ts";

const allDecisionPacks = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);
/** Decision packs the host has not measured yet: they run on the built-in engines (`decisionEngines`) and have no entry until a scorecard writes one. */
// Packs the host has not measured yet: they have no entry and run on the built-in engines until it does (the scorecard run adds the entry and empties this).
const UNMEASURED: string[] = ["ticket_assess", "size_estimate", "split_check"];
const decisionPacks = allDecisionPacks.filter((id) => !UNMEASURED.includes(id));

describe("decision-defaults.json", () => {
  it("has an entry for every decision pack and none for anything else", () => {
    expect(Object.keys(DECISION_DEFAULTS).sort()).toEqual([...decisionPacks].sort());
  });

  it("gives a pack that has no entry yet the built-in engines", () => {
    // A decision pack added by a later wave has no entry until the host measures it: it runs on the built-in engines meanwhile.
    for (const id of [...UNMEASURED, "a_pack_not_measured_yet"]) {
      expect(DECISION_DEFAULTS[id]).toBeUndefined();
      expect(decisionEngines(id).default).toBe("jev");
    }
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

  it("boots on the built-in defaults, with one warning, when the file cannot be read or parsed", async () => {
    for (const body of [null, "{ not json"]) {
      vi.resetModules();
      vi.doMock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()), readFileSync: () => { if (body === null) throw new Error("ENOENT"); return body; } }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await import("./decision-defaults.ts");
      expect(mod.DECISION_DEFAULTS).toEqual({});
      expect(mod.decisionEngines("event_class")).toEqual({ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      vi.doUnmock("node:fs");
    }
  });
});
