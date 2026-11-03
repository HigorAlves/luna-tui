// The catalog and the engines checked against the packs: every engine a pack may run on exists,
// names a catalog model that can serve the pack and the pack's effort, and is not retired; and
// no source file outside the catalog names a provider's model ID.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { ENGINES, EngineId, MODELS, type ModelEntry, PACKS, StageInput, credentialOwner, resolveEngine, retired } from "./index.ts";

const ROOT = join(import.meta.dirname, "..", "..");

describe("the model catalog and the engines", () => {
  it("pins every Claude engine to a full model ID, and resolves an engine to its runtime, ID and caps", () => {
    expect(resolveEngine("claude:opus")).toEqual({ id: "claude:opus", runtime: "claude", modelId: "claude-opus-5-5", caps: MODELS["anthropic/opus-5.5"].caps });
    expect(resolveEngine("claude:sonnet").modelId).toBe("claude-sonnet-5-5");
    expect(resolveEngine("claude:haiku").modelId).toBe("claude-haiku-5-5");
    expect(resolveEngine("codex:luna")).toMatchObject({ runtime: "eve", modelId: "gpt-6-luna-fast" });
    expect(resolveEngine("jev")).toMatchObject({ runtime: "jev", modelId: "jev-latest", caps: { tools: false, structured: true } });
    expect(ENGINES["codex:sol"].auth).toBe("chatgpt");
    expect(ENGINES["openai:sol"].auth).toBe("api-key");
    expect(EngineId.options.sort()).toEqual(["claude:haiku", "claude:opus", "claude:sonnet", "codex:luna", "codex:sol", "jev", "openai:luna", "openai:sol"]);
  });

  it("names whose credential, and so whose usage window, each engine spends", () => {
    const owners = Object.fromEntries(EngineId.options.map((engine) => [engine, credentialOwner(engine)]));
    expect(owners).toEqual({
      "claude:opus": "claude",
      "claude:sonnet": "claude",
      "claude:haiku": "claude",
      "codex:sol": "codex",
      "codex:luna": "codex",
      "openai:sol": "openai",
      "openai:luna": "openai",
      jev: "typesafe",
    });
  });

  it("names every engine's model in the catalog", () => {
    for (const [id, engine] of Object.entries(ENGINES)) expect(MODELS[engine.model], id).toBeDefined();
  });

  it("retires a deprecated model the day after its retireAfter, and nothing else", () => {
    const old: ModelEntry = { runtime: "claude", id: "x", status: "deprecated", retireAfter: "2026-12-31", caps: { tools: true, structured: true, effort: ["low"] } };
    expect(retired(old, "2026-12-31")).toBe(false);
    expect(retired(old, "2027-01-01")).toBe(true);
    expect(retired({ ...old, status: "ga" }, "2099-01-01")).toBe(false);
    expect(retired({ ...old, retireAfter: undefined }, "2099-01-01")).toBe(false);
  });

  it("a stage input may name the engine to run", () => {
    const input = { schema: 3, stage: "triage", pack: "triage", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "/r", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null }, limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
    expect(StageInput.parse(input).engine).toBeUndefined();
    expect(StageInput.parse({ ...input, engine: "codex:sol" }).engine).toBe("codex:sol");
    expect(StageInput.safeParse({ ...input, engine: "gpt-6-sol" }).success).toBe(false);
  });
});

describe("the engines each pack may run on", () => {
  // The real clock: the rule's point is to fail on the day a referenced model retires.
  const today = new Date().toISOString().slice(0, 10);

  it.each(Object.values(PACKS).map((p) => [p.id, p] as const))("%s: a default it allows, engines that exist and can serve it", (_id, pack) => {
    expect(pack.engines.allowed).toContain(pack.engines.default);
    for (const id of pack.engines.allowed) {
      const engine = ENGINES[id];
      expect(engine, id).toBeDefined();
      const model = MODELS[engine.model];
      expect(model, `${id} → ${engine.model}`).toBeDefined();
      // An agent pack calls tools and answers through structured output; a decision pack only answers.
      if (pack.kind === "decision") expect(model.caps.structured, id).toBe(true);
      else {
        if (pack.agent) expect(model.caps, id).toMatchObject({ tools: true, structured: true });
        expect(model.caps.effort, `${id} at ${pack.effort}`).toContain(pack.effort);
      }
      expect(retired(model, today), `${id} → ${engine.model} retired after ${model.retireAfter}`).toBe(false);
    }
  });

  it("lets Codex take the Slack inbox and triage, as candidates beside their Claude defaults, each the other's fallback", () => {
    expect(PACKS.slack_triage.engines).toEqual({ default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"], fallback: ["codex:luna", "claude:haiku"] });
    expect(PACKS.chat_triage.engines).toEqual({ default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"], fallback: ["codex:luna", "claude:haiku"] });
    expect(PACKS.triage.engines).toEqual({ default: "claude:opus", allowed: ["claude:opus", "codex:sol"], fallback: ["codex:sol", "claude:opus"] });
  });

  it.each(Object.values(PACKS).map((p) => [p.id, p] as const))("%s: falls back only to engines it allows, each once", (_id, pack) => {
    const fallback = pack.engines.fallback ?? [];
    for (const id of fallback) expect(pack.engines.allowed, `${pack.id} falls back to ${id}`).toContain(id);
    expect(new Set(fallback).size).toBe(fallback.length);
  });

  it("gives a Claude-only pack no fallback", () => {
    const claudeOnly = Object.values(PACKS).filter((p) => p.engines.allowed.every((id) => id.startsWith("claude:")));
    expect(claudeOnly.length).toBeGreaterThan(0);
    for (const pack of claudeOnly) expect(pack.engines.fallback, pack.id).toBeUndefined();
  });

  it("keeps today's models as the defaults", () => {
    const defaults = Object.fromEntries(Object.values(PACKS).map((p) => [p.id, p.engines.default]));
    expect(defaults).toMatchObject({ setup: "claude:opus", triage: "claude:opus", implementing: "claude:sonnet", verifying: "claude:opus", slack_triage: "claude:haiku", jira_intake: "claude:sonnet", issue_classify: "jev" });
  });
});

/** Every non-test TypeScript file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "__fixtures__" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("model IDs", () => {
  it("appear in no source file but the catalog", () => {
    const ids = Object.values(MODELS).map((m) => m.id);
    // A whole ID, not part of a catalog key (`openai/gpt-6-sol`) or of a longer name.
    const pattern = new RegExp(`(?<![\\w./-])(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w.-])`);
    const files = ["contracts/src", "factory/src", "machine/src"].flatMap((dir) => sources(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) => !file.endsWith(join("contracts", "src", "models.ts")) && pattern.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
