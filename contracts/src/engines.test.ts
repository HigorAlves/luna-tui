// The catalog and the engines checked against the packs: every engine a pack may run on exists,
// names a catalog model that can serve the pack and the pack's effort, and is not retired; and
// no source file outside the catalog names a provider's model ID.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { AGENT_PACKS, ENGINES, EngineBudgets, EngineId, MODELS, type ModelEntry, PACKS, StageInput, credentialOwner, engineBudgetKeyProblem, helperPack, readOnly, resolveEngine, retired } from "./index.ts";

const ROOT = join(import.meta.dirname, "..", "..");

describe("the model catalog and the engines", () => {
  it("pins every Claude engine to a full model ID, and resolves an engine to its runtime, ID and caps", () => {
    expect(resolveEngine("claude:opus")).toEqual({ id: "claude:opus", runtime: "claude", modelId: "claude-opus-5-5", caps: MODELS["anthropic/opus-5.5"].caps });
    expect(resolveEngine("claude:sonnet").modelId).toBe("claude-sonnet-5-5");
    expect(resolveEngine("claude:haiku").modelId).toBe("claude-haiku-5-5");
    expect(resolveEngine("codex:luna")).toMatchObject({ runtime: "eve", modelId: "gpt-6-luna-fast" });
    expect(resolveEngine("jev")).toMatchObject({ runtime: "jev", modelId: "jev-latest", caps: { tools: false, structured: true } });
    // Jev is also served on the Vercel AI Gateway, under its own ID, at the catalog's one price.
    expect(resolveEngine("jev")).toMatchObject({ gatewayId: "typesafe-ai/jev", pricing: { inputPerMTokUsd: 0.042 } });
    expect(resolveEngine("claude:opus")).not.toHaveProperty("gatewayId");
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

  it.each(AGENT_PACKS.map((p) => [p.id, p] as const))("%s: helpers run as agent roles, each once, on engines that can serve an agent at the pack's effort", (_id, pack) => {
    expect(new Set(pack.helpers.map((h) => h.role)).size).toBe(pack.helpers.length);
    for (const helper of pack.helpers) {
      expect(helper.role, `${pack.id}: a helper is not the pack's own role`).not.toBe(pack.agent);
      const engine = resolveEngine(helper.engine);
      // A decision runtime has no role, tools or prompt: it cannot be a helper.
      expect(engine.runtime, `${pack.id}: ${helper.role} on ${helper.engine}`).not.toBe("jev");
      expect(engine.caps, helper.engine).toMatchObject({ tools: true, structured: true });
      expect(engine.caps.effort, `${helper.engine} at ${pack.effort}`).toContain(pack.effort);
      expect(retired(MODELS[ENGINES[helper.engine].model], today), helper.engine).toBe(false);
      // A helper on Claude beside a Claude default is a subagent: the role needs the Agent tool.
      if (engine.runtime === "claude" && resolveEngine(pack.engines.default).runtime === "claude") expect(pack.access.agent, `${pack.id} dispatches ${helper.role}`).toBe(true);
    }
  });

  it("keeps today's subagents on their engines, and gives the verifier a second opinion on Codex", () => {
    expect(PACKS.reviewing.helpers).toEqual([{ role: "security-reviewer", engine: "claude:opus" }]);
    expect(PACKS.addressing.helpers).toEqual([{ role: "reply-drafter", engine: "claude:haiku" }]);
    expect(PACKS.verifying.helpers).toEqual([{ role: "second-opinion", engine: "codex:sol" }]);
  });

  it("runs a helper as a read-only pack of its own on the helper's engine, answering in a reply and findings", () => {
    const run = helperPack(PACKS.reviewing, { role: "security-reviewer", engine: "claude:opus" });
    expect(run).toMatchObject({ id: "reviewing", kind: "agent", agent: "security-reviewer", helpers: [], skills: [], writable: false, engines: { default: "claude:opus", allowed: ["claude:opus"] }, effort: "high", template: "helper.md" });
    expect(run.access).toEqual(readOnly(PACKS.reviewing.access));
    expect(run.answer.safeParse({ answer: "looks fine" }).success).toBe(true);
    expect(run.answer.safeParse({ answer: "one bug", findings: [{ path: "a.ts", line: 1, severity: "bug", title: "t", body: "b", confidence: 0.9 }] }).success).toBe(true);
    expect(run.answer.safeParse({ findings: [] }).success).toBe(false);
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

  it("gives every decision pack an engine besides Jev to fall back to", () => {
    for (const pack of Object.values(PACKS).filter((p) => p.kind === "decision")) {
      expect(pack.engines.allowed.filter((e) => e !== "jev").length, pack.id).toBeGreaterThan(0);
      expect(pack.engines.fallback?.some((e) => e !== "jev"), pack.id).toBe(true);
    }
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

describe("monthly caps per engine", () => {
  it("names an engine or a credential, never Claude, whose engines are every pack's default", () => {
    for (const key of ["codex", "openai", "typesafe", "jev", "openai:sol", "codex:luna"]) expect(engineBudgetKeyProblem(key), key).toBeNull();
    expect(engineBudgetKeyProblem("claude")).toMatch(/^claude: no monthly cap on Claude/);
    expect(engineBudgetKeyProblem("claude:opus")).toMatch(/^claude:opus: no monthly cap on Claude/);
    expect(engineBudgetKeyProblem("gpt-6")).toBe("gpt-6: not an engine or a credential (codex, openai, typesafe)");
  });

  it("validates a map of caps in USD, zero allowed, naming the bad key", () => {
    expect(EngineBudgets.parse({ "openai:sol": 10, codex: 0 })).toEqual({ "openai:sol": 10, codex: 0 });
    expect(EngineBudgets.safeParse({ openai: -1 }).success).toBe(false);
    const bad = EngineBudgets.safeParse({ "claude:haiku": 5 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["claude:haiku"]);
  });
});

