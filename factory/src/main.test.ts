// The entry, end to end without a model: a dry run of every agent pack renders the prompt,
// prints the SDK options and leaves a result the machine's contract accepts; the evidence
// pack reads the QA manifest; a bad input still leaves a result that says why.
import { AGENT_PACKS, type AgentPack, PACKS, type PackId, RunEvent, StageOutput, helpersOn, resolveEngine } from "@hardness/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeTools } from "./runtimes/claude/access.ts";

const MAIN = join(import.meta.dirname, "main.ts");

const stageInput = (pack: PackId, over: Record<string, unknown> = {}) => ({
  schema: 3,
  stage: pack,
  pack,
  attempt: 1,
  task: { id: "t1", title: "Fix the bug", description: "It breaks", criteria: ["no crash"], repoPath: "/r", branch: "task/t1-fix", source: null },
  plan: { brief: "do it", criteria: ["c1"], assumptions: [], slices: [{ title: "s1", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }] },
  decisions: [],
  priorFindings: [],
  context: { projectContext: null, testCases: [] },
  limits: { maxTurns: 5, timeoutMs: 1000 },
  env: { LUNA_FACTORY: "1" },
  ...over,
});

const slack = {
  me: { id: "U1", name: "higor" },
  watches: [{ label: "@platform-team", kind: "usergroup" }],
  rules: "## Notes\n- short replies\n",
  items: [{ id: "C1:1", channel: "#eng", author: "@marta", isBot: false, text: "can you review?", context: [], matched: ["me"], threadReplies: 0 }],
};

function run(input: unknown, env: Record<string, string> = {}, files: Record<string, string> = {}, { emptyWork = false, contextIsDir = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-main-"));
  const inDir = join(root, "in");
  const out = join(root, "out");
  const work = join(root, "work");
  mkdirSync(inDir);
  mkdirSync(out);
  mkdirSync(work);
  if (contextIsDir) {
    mkdirSync(join(work, "docs", "agents", "project-context.md"), { recursive: true });
  } else if (!emptyWork) {
    mkdirSync(join(work, "docs", "agents"), { recursive: true });
    writeFileSync(join(work, "docs", "agents", "project-context.md"), "# Project context\n\n- Keep it small.\n");
  }
  writeFileSync(join(inDir, "stage.json"), JSON.stringify(input));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(out, rel, ".."), { recursive: true });
    writeFileSync(join(out, rel), body);
  }
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [MAIN], {
      encoding: "utf8",
      env: { ...process.env, LUNA_STAGE_IN: join(inDir, "stage.json"), LUNA_STAGE_OUT: out, LUNA_STAGE_WORK: work, LUNA_STAGE_DRY_RUN: "1", ...env },
    });
  } catch (error) {
    const e = error as { status: number; stdout: string };
    code = e.status;
    stdout = e.stdout;
  }
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  return { code, stdout, out, result };
}

// slack_triage, chat_triage and eval_judge have no worktree and read no project context; their dry runs are below.
const agentPacks = AGENT_PACKS.filter((p) => p.agent !== null && p.id !== "slack_triage" && p.id !== "chat_triage" && p.id !== "eval_judge").map((p) => p.id);

describe("factory main (dry run)", () => {
  it.each(agentPacks)("%s: renders the prompt, prints the options and leaves a valid result", (pack) => {
    const { code, stdout, out, result } = run(stageInput(pack));
    expect(code).toBe(0);
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain(`running the \`${pack}\` stage`);
    expect(prompt).toContain("Keep it small.");
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    const def = PACKS[pack] as AgentPack;
    expect(options).toMatchObject({ agent: def.agent, agents: [def.agent, ...helpersOn(def, "claude").filter((h) => resolveEngine(h.engine).runtime === "claude").map((h) => h.role)], model: resolveEngine(def.engines.default).modelId, effort: def.effort, maxTurns: 5, permissionMode: "dontAsk", settingSources: [], hooks: ["PreToolUse"], mcpServers: ["luna"] });
    // Commits and PRs are the person's: no attribution from the SDK.
    expect(options.settings).toEqual({ attribution: false, includeCoAuthoredBy: false });
    // A helper on another runtime is reached through `delegate`, beside the pack's own tools.
    const delegating = helpersOn(def, "claude").some((h) => resolveEngine(h.engine).runtime !== "claude") ? ["mcp__luna__delegate"] : [];
    const { tools, allowedTools } = claudeTools(def.access);
    expect(options).toMatchObject({ tools: [...tools, ...delegating], allowedTools: [...allowedTools, ...delegating] });
    if (pack === "verifying") expect(options.allowedTools).toContain("mcp__luna__delegate");
    expect(options.tools.every((t: string) => !t.includes("("))).toBe(true);
    expect(options.plugins[0].path).toMatch(/factory\/plugin$/);
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run", ledger: { schema: 1, slices: [] } });
    // The run's events in order: the options it would run with, then the stage's end.
    const events = readFileSync(join(out, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((e) => e.kind)).toEqual(["session", "note"]);
    expect(events.every((e) => RunEvent.safeParse(e).success)).toBe(true);
    expect(events[1].payload).toMatchObject({ phase: "stage_end" });
  });

  it("slack_triage: runs over an empty /work with no tools, renders the batch and leaves a valid result", () => {
    const task = { id: "slack-triage", title: "Slack triage", description: "", criteria: [], repoPath: "", branch: "", source: null };
    const { code, stdout, out, result } = run(stageInput("slack_triage", { task, plan: null, context: { projectContext: null, slack } }), {}, {}, { emptyWork: true });
    expect(code).toBe(0);
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("`slack-triager` role running the `slack_triage` stage");
    expect(prompt).toContain("higor (U1)");
    expect(prompt).toContain("- @platform-team (usergroup)");
    expect(prompt).toContain("id C1:1 · #eng · @marta · matched me");
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({ agent: "slack-triager", agents: ["slack-triager"], model: "claude-haiku-5-5", effort: "low", maxTurns: 5, tools: [], allowedTools: [] });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run" });
  });

  it("eval_judge: runs on opus over an empty /work with no tools, renders the case and leaves a valid result", () => {
    const task = { id: "eval", title: "Eval judge", description: "", criteria: [], repoPath: "", branch: "", source: null };
    const judged = { pack: "slack_triage", caseId: "incident", rubric: "P0 for the outage", input: "{}", checks: "[]", answer: '{"items":[]}' };
    const { code, stdout, out, result } = run(stageInput("eval_judge", { task, plan: null, context: { projectContext: null, eval: judged } }), {}, {}, { emptyWork: true });
    expect(code).toBe(0);
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("grade one answer to case incident");
    expect(prompt).toContain("P0 for the outage");
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({ agent: "eval-judge", model: "claude-opus-5-5", tools: [], allowedTools: [] });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
  });

  it.each([
    ["teams", { source: "teams", me: { id: "8f2c", name: "Higor Alves" }, items: [{ id: "chat:19:abc", place: "Rafa Souza", kind: "dm", author: "Rafa Souza", isBot: false, text: "approve the rollout?", flag: "urgent" }] }, "id chat:19:abc · dm Rafa Souza · Rafa Souza · matched (none) · flag urgent"],
    ["slack", { source: "slack", me: { id: "U1", name: "higor" }, items: [{ id: "C1:1", place: "#eng", kind: "channel", author: "@marta", isBot: false, text: "review?", matched: ["me"] }] }, "id C1:1 · channel #eng · @marta · matched me"],
  ])("chat_triage (%s): runs over an empty /work with no tools, renders the batch and leaves a valid result", (_source, chat, line) => {
    const task = { id: "chat-triage", title: "Chat triage", description: "", criteria: [], repoPath: "", branch: "", source: null };
    const { code, stdout, out, result } = run(stageInput("chat_triage", { task, plan: null, context: { projectContext: null, chat } }), {}, {}, { emptyWork: true });
    expect(code).toBe(0);
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("`chat-triager` role running the `chat_triage` stage");
    expect(prompt).toContain(line);
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({ agent: "chat-triager", agents: ["chat-triager"], model: "claude-haiku-5-5", effort: "low", maxTurns: 5, tools: [], allowedTools: [] });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run" });
  });

  it("jira_intake: runs over the repo checkout read-only with Read, Glob and Grep, renders the issue and leaves a valid result", () => {
    const task = { id: "jira-intake", title: "Login page", description: "Users sign in.", criteria: [], repoPath: "/r/a", branch: "", source: null };
    const jira = { key: "PLAT-123", url: "https://acme.atlassian.net/browse/PLAT-123", summary: "Login page", description: "Users sign in.", issueType: "Story", priority: "High", labels: ["luna"], dueAt: null, comments: ["Marta: please"], repoPath: "/r/a" };
    const { code, stdout, out, result } = run(stageInput("jira_intake", { task, plan: null, context: { projectContext: null, jira } }));
    expect(code).toBe(0);
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("`jira-triager` role running the `jira_intake` stage");
    expect(prompt).toContain("PLAT-123 · Story · priority High · labels luna");
    expect(prompt).toContain("- Marta: please");
    expect(prompt).toContain("Keep it small.");
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({ agent: "jira-triager", agents: ["jira-triager"], model: "claude-sonnet-5-5", effort: "low", tools: ["Read", "Glob", "Grep"], allowedTools: ["Read", "Glob", "Grep"] });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run" });
  });

  it("triage_signals on Jev: renders no prompt, prints the questions and the issue it would send, and leaves a valid result", () => {
    const issue = { title: "Board crashes on resize", description: "It panics.", labels: ["bug"] };
    const { code, stdout, out, result } = run(stageInput("triage_signals", { plan: null, engine: "jev", context: { projectContext: null, issue } }), {}, {}, { emptyWork: true });
    expect(code).toBe(0);
    expect(existsSync(join(out, "prompt.md"))).toBe(false);
    expect(stdout).toContain("pack triage_signals as a decision");
    const request = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(request).toMatchObject({ model: resolveEngine("jev").modelId, state: issue, questions: { kind: { type: "choice" }, ready: { type: "noul" }, size: { type: "choice" }, who: { type: "score" } } });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run" });
  });

  it("triage_signals on claude:haiku: one answer within three turns, with no agent, no tools and no MCP server", () => {
    const { code, stdout, out, result } = run(stageInput("triage_signals", { plan: null, engine: "claude:haiku", context: { projectContext: null, issue: { title: "Board crashes", description: "It panics." } } }), {}, {}, { emptyWork: true });
    expect(code).toBe(0);
    expect(stdout).not.toContain("has no agent to run");
    expect(existsSync(join(out, "prompt.md"))).toBe(false);
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({ outputFormat: { type: "json_schema" }, maxTurns: 3, tools: [], allowedTools: [], model: resolveEngine("claude:haiku").modelId });
    expect(options.agent).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(result).toMatchObject({ ok: true, outcome: "pass", summary: "dry-run" });
  });

  it("triage_signals on Jev without a key: ends the stage with ok false and the reason, without a crash", () => {
    const { code, result } = run(stageInput("triage_signals", { engine: "jev" }), { LUNA_STAGE_DRY_RUN: "0", TYPESAFE_API_KEY: "", AI_GATEWAY_API_KEY: "" });
    expect(code).toBe(0);
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ ok: false, outcome: "fail", rateLimited: false, error: expect.stringContaining("neither AI_GATEWAY_API_KEY nor TYPESAFE_API_KEY is set") });
  });

  it("records what the run ran on and a fingerprint that holds across attempts and changes with the runtime and the pack", () => {
    const first = run(stageInput("triage", { engine: "claude:haiku" })).result;
    expect(first.run).toEqual({
      runtime: "claude",
      engine: "claude:haiku",
      modelId: "claude-haiku-5-5",
      sdk: { name: "@anthropic-ai/claude-agent-sdk", version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The task's data and the model are not the harness: another attempt on another Claude model is the same fingerprint.
    expect(run(stageInput("triage", { engine: "claude:opus", attempt: 2, task: { ...stageInput("triage").task, title: "Another bug" } })).result.run.fingerprint).toBe(first.run.fingerprint);
    // eve gives the model its own rules and tool names: another fingerprint, on eve's SDK.
    const eve = run(stageInput("triage", { engine: "codex:sol" })).result.run;
    expect(eve).toMatchObject({ runtime: "eve", engine: "codex:sol", sdk: { name: "eve", version: expect.any(String) } });
    expect(eve.fingerprint).not.toBe(first.run.fingerprint);
    expect(run(stageInput("test_design")).result.run.fingerprint).not.toBe(first.run.fingerprint);
    expect(run(stageInput("triage_signals", { plan: null, engine: "jev" }), {}, {}, { emptyWork: true }).result.run).toMatchObject({ runtime: "jev", sdk: { name: "@typesafe-ai/sdk" } });
  });

  it("runs the engine the input names, by its pinned model ID", () => {
    const { stdout } = run(stageInput("triage", { engine: "claude:haiku" }));
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options.model).toBe("claude-haiku-5-5");
  });

  it("ends the stage, without a crash, on an engine whose runtime cannot run the pack", () => {
    // Every runtime is registered now, so the mismatch left is a decision engine on an agent pack.
    const { code, result } = run(stageInput("triage", { engine: "jev" }));
    expect(code).toBe(0);
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ ok: false, outcome: "fail", error: "pack triage is not a decision pack" });
  });

  it("runs an eve engine on eve: the compiled agent, the engine's model through the Codex login, the pack's guard", () => {
    const { code, stdout, result } = run(stageInput("triage", { engine: "codex:sol" }));
    expect(code).toBe(0);
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({
      agent: expect.stringMatching(/\.eve-agents\/triage$/),
      model: "chatgpt(gpt-5.6-terra)",
      reasoning: "high",
      tools: ["bash", "read_file", "glob", "grep", "web_fetch", "step", "decision_get", "card_search", "delegate"],
      guard: { writable: false, commands: expect.arrayContaining(["gh issue view"]), roots: { scratch: expect.stringMatching(/luna-scratch-/), read: [expect.stringMatching(/\/in$/), "/graph"] } },
    });
    expect(result).toMatchObject({ ok: true, summary: "dry-run" });
  });

  it("takes a structured answer through the test seam and maps its kind to the outcome", () => {
    const answer = { kind: "questions", summary: "which?", questions: [{ question: "db?", recommended: "sqlite" }] };
    const { result } = run(stageInput("triage"), { LUNA_STAGE_DRY_STRUCTURED: JSON.stringify(answer) });
    expect(result).toMatchObject({ outcome: "needs_input", needsInput: answer.questions, answer });
  });

  it("evidence: passes on a pass or skipped manifest, fails without one, never calls a model", () => {
    const pass = run(stageInput("evidence"), {}, { "files/qa/qa-manifest.json": JSON.stringify({ verdict: "pass" }) });
    expect(pass.result).toMatchObject({ ok: true, outcome: "pass", summary: "qa pass" });
    expect(pass.result.artifacts).toEqual([expect.objectContaining({ kind: "qa-manifest", path: "files/qa/qa-manifest.json" })]);
    const skipped = run(stageInput("evidence"), {}, { "files/qa/qa-manifest.json": JSON.stringify({ verdict: "skipped" }) });
    expect(skipped.result).toMatchObject({ ok: true, outcome: "pass" });
    const missing = run(stageInput("evidence"));
    expect(missing.result).toMatchObject({ ok: false, outcome: "fail", error: expect.stringContaining("missing") });
    // No runtime ran it, so there is nothing to fingerprint.
    expect(pass.result.run).toBeNull();
  });

  it("leaves a result that names the problem when the stage fails partway, instead of crashing", () => {
    // A project context that cannot be read (a folder where the file should be) throws while the
    // prompt is rendered.
    const { code, result } = run(stageInput("triage"), {}, {}, { contextIsDir: true });
    expect(code).toBe(0);
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ ok: false, outcome: "fail", error: expect.stringMatching(/EISDIR/) });
  });

  it("takes the luna tools from core: no runtime's SDK is loaded for another runtime's stage", () => {
    expect(readFileSync(MAIN, "utf8")).not.toMatch(/claude/);
    expect(readFileSync(join(import.meta.dirname, "runtimes", "index.ts"), "utf8")).not.toMatch(/luna/);
  });

  it("leaves a result that names the problem when the stage input is invalid", () => {
    const { code, result } = run({ schema: 3, stage: "triage" });
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, outcome: "fail", error: expect.stringContaining("invalid stage input") });
  });

  it("starts the ledger from the one the input carries", () => {
    const ledger = { schema: 1, slices: [{ id: 1, title: "a", status: "committed", commit: "x" }] };
    const { result } = run(stageInput("reviewing_memory", { context: { projectContext: null, ledger, runs: [] } }));
    expect(result.ledger).toEqual(ledger);
  });

  describe("a prompt that was cut", () => {
    const scenarios = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, title: `scenario ${i + 1}`, criterion: "c ".repeat(200), approach: "run it", type: "happy", layer: "unit", given: "g", when: "w", then: "t" }));

    it("does not run the stage when the scenarios it must write tests for were cut: the result says what was lost", () => {
      const { result, out } = run(stageInput("build_tests", { stage: "implementing", context: { projectContext: null, testCases: scenarios(600) } }));
      expect(result).toMatchObject({ ok: false, outcome: "fail", error: expect.stringMatching(/the stage's input was cut.*context\.testCases lost \d+ characters/) });
      const events = readFileSync(join(out, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(events).toContainEqual({ kind: "note", payload: expect.objectContaining({ phase: "prompt_cut", pack: "build_tests", cuts: [expect.objectContaining({ name: "context.testCases", whole: true })] }) });
    });

    it("runs on a 13-scenario plan, with no cut noted", () => {
      const { result, out } = run(stageInput("build_tests", { stage: "implementing", context: { projectContext: null, testCases: scenarios(13) } }));
      expect(result.error).toBeNull();
      expect(readFileSync(join(out, "events.jsonl"), "utf8")).not.toContain("prompt_cut");
    });
  });
});
