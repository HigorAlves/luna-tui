import { type EngineId, PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { chooseEngine, engineProblem, stagesProblem } from "./engine-choice.ts";

// No pack allows two engines yet, so the choice is proved on one that does.
const triage = { id: "triage" as const, engines: { default: "claude:opus" as EngineId, allowed: ["claude:opus", "codex:sol", "openai:sol"] as EngineId[] } };
const everything = () => null;

describe("chooseEngine", () => {
  it("runs the pack's default when nothing names another", () => {
    expect(chooseEngine({ pack: triage, missing: everything })).toEqual({ engine: "claude:opus", source: "default", reason: null });
  });

  it("takes luna.yaml's engine over the default, and the task's own over luna.yaml", () => {
    expect(chooseEngine({ pack: triage, config: { triage: "openai:sol" }, missing: everything })).toEqual({ engine: "openai:sol", source: "config", reason: null });
    expect(chooseEngine({ pack: triage, task: { triage: "codex:sol" }, config: { triage: "openai:sol" }, missing: everything })).toEqual({ engine: "codex:sol", source: "task", reason: null });
    // Another pack's override is not this one's.
    expect(chooseEngine({ pack: triage, task: { verifying: "codex:sol" }, missing: everything }).engine).toBe("claude:opus");
  });

  it("never runs an engine the pack does not allow: the override is passed over, with why", () => {
    const choice = chooseEngine({ pack: triage, task: { triage: "jev" }, config: { triage: "openai:sol" }, missing: everything });
    expect(choice).toEqual({ engine: "openai:sol", source: "config", reason: "the task's jev is not allowed for triage (allowed: claude:opus, codex:sol, openai:sol); ignored" });
    expect(chooseEngine({ pack: triage, config: { triage: "claude:haiku" }, missing: everything })).toMatchObject({ engine: "claude:opus", source: "default", reason: expect.stringMatching(/^luna\.yaml's claude:haiku is not allowed for triage/) });
  });

  it("falls back to the pack's default when the chosen engine's credential is missing here", () => {
    const missing = (engine: EngineId) => (engine === "codex:sol" ? "no Codex login (~/.codex/auth.json)" : null);
    expect(chooseEngine({ pack: triage, task: { triage: "codex:sol" }, missing })).toEqual({
      engine: "claude:opus",
      source: "default",
      reason: "codex:sol has no credential on this machine (no Codex login (~/.codex/auth.json)); ran claude:opus, the pack's default",
      note: "triage ran on claude:opus: codex:sol has no Codex login on this machine",
    });
    expect(chooseEngine({ pack: triage, config: { triage: "openai:sol" }, missing: () => "unset" }).note).toBe("triage ran on claude:opus: openai:sol has no OpenAI API key on this machine");
    // The default itself is never passed over: without its credential the stage cannot run at all, and says so itself.
    expect(chooseEngine({ pack: triage, missing: () => "nothing" })).toEqual({ engine: "claude:opus", source: "default", reason: null });
  });

  it("keeps both reasons when the task's engine is not allowed and luna.yaml's has no credential", () => {
    const choice = chooseEngine({ pack: triage, task: { triage: "jev" }, config: { triage: "openai:sol" }, missing: (engine) => (engine === "openai:sol" ? "no OPENAI_API_KEY" : null) });
    expect(choice.engine).toBe("claude:opus");
    expect(choice.reason).toBe(
      "the task's jev is not allowed for triage (allowed: claude:opus, codex:sol, openai:sol); ignored; openai:sol has no credential on this machine (no OPENAI_API_KEY); ran claude:opus, the pack's default",
    );
  });
});

describe("engineProblem and stagesProblem", () => {
  it("says why an engine cannot run a pack, against the registry", () => {
    expect(engineProblem("triage", PACKS.triage.engines.default)).toBeNull();
    expect(engineProblem("triage", "jev")).toBe(`jev is not allowed for triage (allowed: ${PACKS.triage.engines.allowed.join(", ")})`);
  });

  it("names the first pack whose engine is not allowed, else null", () => {
    expect(stagesProblem({})).toBeNull();
    expect(stagesProblem({ triage: PACKS.triage.engines.default, implementing: PACKS.implementing.engines.default })).toBeNull();
    expect(stagesProblem({ triage: PACKS.triage.engines.default, verifying: "jev" })).toMatch(/^verifying: jev is not allowed for verifying/);
  });
});
