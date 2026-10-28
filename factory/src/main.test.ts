// The entry, end to end without a model: a dry run of every agent pack renders the prompt,
// prints the SDK options and leaves a result the machine's contract accepts; the evidence
// pack reads the QA manifest; a bad input still leaves a result that says why.
import { PACKS, type PackId, StageOutput } from "@hardness/contracts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

function run(input: unknown, env: Record<string, string> = {}, files: Record<string, string> = {}, { emptyWork = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-main-"));
  const inDir = join(root, "in");
  const out = join(root, "out");
  const work = join(root, "work");
  mkdirSync(inDir);
  mkdirSync(out);
  mkdirSync(work);
  if (!emptyWork) {
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

// slack_triage has no worktree and reads no project context; its dry run is below.
const agentPacks = Object.values(PACKS).filter((p) => p.agent !== null && p.id !== "slack_triage").map((p) => p.id);

describe("factory main (dry run)", () => {
  it.each(agentPacks)("%s: renders the prompt, prints the options and leaves a valid result", (pack) => {
    const { code, stdout, out, result } = run(stageInput(pack));
    expect(code).toBe(0);
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain(`running the \`${pack}\` stage`);
    expect(prompt).toContain("Keep it small.");
    const options = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    expect(options).toMatchObject({ agent: PACKS[pack].agent, agents: [PACKS[pack].agent, ...PACKS[pack].helpers], model: PACKS[pack].model, effort: PACKS[pack].effort, maxTurns: 5, permissionMode: "dontAsk", settingSources: [], hooks: ["PreToolUse"], mcpServers: ["luna"] });
    expect(options.allowedTools).toEqual(PACKS[pack].tools);
    expect(options.tools).toEqual([...new Set(PACKS[pack].tools.map((t) => t.replace(/\(.*\)$/, "")))]);
    expect(options.tools.every((t: string) => !t.includes("("))).toBe(true);
    expect(options.plugins[0].path).toMatch(/factory\/plugin$/);
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run", ledger: { schema: 1, slices: [] } });
    expect(readFileSync(join(out, "events.jsonl"), "utf8")).toContain('"stage_end"');
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
    expect(options).toMatchObject({ agent: "slack-triager", agents: ["slack-triager"], model: "haiku", effort: "low", maxTurns: 5, tools: [], allowedTools: [] });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(result).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "dry-run" });
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
});
