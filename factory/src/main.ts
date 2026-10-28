// Runs one pipeline stage inside its container.
//   in:  /in/stage.json, a StageInput from the machine
//   out: /out/result.json (StageOutput), /out/events.jsonl, /out/ledger.json, /out/files/**
//   cwd: /work, the task's worktree
// Stdout is a readable transcript; the board's watch pane follows it with `docker logs -f`.
// LUNA_STAGE_DRY_RUN=1 renders the prompt and the SDK options without a model call.
// LUNA_STAGE_DEBUG=1 also writes every SDK message to /out/raw.jsonl.
import { PACKS, StageInput, answerJsonSchema } from "@hardness/contracts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentDefinitions } from "./agents.ts";
import { branchPrefixFor, preToolUseGuards } from "./hooks/guards.ts";
import { EMPTY_RUN, type RunOutcome, finish } from "./output.ts";
import { FACTORY_RULES, callLine, renderPrompt } from "./render.ts";
import { lunaTools } from "./tools/luna.ts";

const env = process.env;
const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IN = env.LUNA_STAGE_IN ?? "/in/stage.json";
const OUT = env.LUNA_STAGE_OUT ?? "/out";
const WORK = env.LUNA_STAGE_WORK ?? "/work";
const DRY = env.LUNA_STAGE_DRY_RUN === "1";

const out = (line: string) => process.stdout.write(`${line}\n`);
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

mkdirSync(OUT, { recursive: true });
const parsed = StageInput.safeParse(readJson(IN));
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  // The machine reads result.json whatever the exit code; a result with the reason beats none.
  writeFileSync(join(OUT, "result.json"), `${JSON.stringify({ ...skeleton(), error: `invalid stage input: ${issues}` }, null, 2)}\n`);
  process.stderr.write(`factory: invalid stage input at ${IN}: ${issues}\n`);
  process.exit(1);
}
const input = parsed.data;
const pack = PACKS[input.pack];
const template = readFileSync(join(FACTORY_ROOT, "prompts", pack.template), "utf8");
const contextFile = join(WORK, "docs", "agents", "project-context.md");
const projectContext = existsSync(contextFile) ? readFileSync(contextFile, "utf8") : null;
const prompt = renderPrompt({ pack, input, template, projectContext });
writeFileSync(join(OUT, "prompt.md"), prompt);

const luna = lunaTools({
  ledgerPath: join(OUT, "ledger.json"),
  ledger: input.context.ledger ?? null,
  decisions: input.decisions,
  onStep: (label, n, of) => out(`· ${label}${of ? ` (${n}/${of})` : ""}`),
});

out(`luna factory · pack ${pack.id} as ${pack.agent ?? "script"} (attempt ${input.attempt})`);

// Script-only pack (evidence): no model. The outcome comes from the QA manifest e2e left.
if (pack.agent === null) {
  const manifest = readJson(join(OUT, "files", "qa", "qa-manifest.json")) as { verdict?: string } | null;
  const verdict = manifest?.verdict ?? null;
  const good = verdict === "pass" || verdict === "skipped";
  const note = good ? `qa ${verdict}` : manifest ? `qa verdict: ${verdict ?? "missing"}` : "qa-manifest.json missing or unreadable";
  finish(OUT, pack, { ...EMPTY_RUN, ok: good, text: note, error: good ? null : note }, luna.state);
  process.exit(0);
}

const options = {
  cwd: WORK,
  agent: pack.agent,
  agents: agentDefinitions(pack, join(FACTORY_ROOT, "agents")),
  systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: FACTORY_RULES },
  plugins: [{ type: "local" as const, path: join(FACTORY_ROOT, "plugin") }],
  settingSources: [] as [],
  // `tools` takes bare names (a scoped rule such as `Bash(git add:*)` is not a name and would
  // drop Bash); the scoped rules go to `allowedTools`, which is what dontAsk consults.
  tools: toolNames(pack.tools),
  allowedTools: pack.tools,
  permissionMode: "dontAsk" as const,
  maxTurns: input.limits.maxTurns,
  outputFormat: { type: "json_schema" as const, schema: answerJsonSchema(pack) },
  mcpServers: { luna: luna.server },
  hooks: {
    PreToolUse: preToolUseGuards({
      writable: pack.writable,
      branch: input.task.branch || null,
      // A PR task commits on the PR's own branch, not a task/ branch.
      branchPrefix: branchPrefixFor(input.task),
      workRoot: WORK,
      outRoot: OUT,
    }),
  },
  model: pack.model,
  effort: pack.effort,
  env: { ...env, LUNA_FACTORY: "1" },
};

if (DRY) {
  const { mcpServers: _m, hooks: _h, env: _e, agents, ...printable } = options;
  out(JSON.stringify({ ...printable, agents: Object.keys(agents), hooks: ["PreToolUse"], mcpServers: ["luna"] }, null, 2));
  let structured: Record<string, unknown> | null = null;
  try {
    structured = env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
  } catch {}
  finish(OUT, pack, { ...EMPTY_RUN, ok: true, structured, text: "dry-run" }, luna.state);
  process.exit(0);
}

const t0 = Date.now();
const run: RunOutcome = { ...EMPTY_RUN };
try {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const raw = env.LUNA_STAGE_DEBUG === "1" ? join(OUT, "raw.jsonl") : null;
  for await (const msg of query({ prompt, options })) {
    if (raw) appendFileSync(raw, `${JSON.stringify(msg)}\n`);
    if ("session_id" in msg && typeof msg.session_id === "string" && !run.sessionId) run.sessionId = msg.session_id;
    if (msg.type === "system" && msg.subtype === "init") {
      run.model = msg.model;
      out(`session ${msg.session_id} · model ${msg.model} · skills ${msg.skills.length} · plugins ${msg.plugins.map((p) => p.name).join(",") || "none"}`);
    } else if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text) out(block.text);
        else if (block.type === "tool_use") out(callLine(block.name, (block.input ?? {}) as Record<string, unknown>));
      }
    } else if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      if (info.status === "rejected") {
        run.rateLimited = true;
        run.resetsAt = info.resetsAt ?? null;
      }
    } else if (msg.type === "result") {
      run.ok = msg.subtype === "success" && !msg.is_error;
      run.structured = msg.subtype === "success" && msg.structured_output && typeof msg.structured_output === "object" ? (msg.structured_output as Record<string, unknown>) : null;
      run.text = msg.subtype === "success" && typeof msg.result === "string" ? msg.result : "";
      run.turns = msg.num_turns ?? 0;
      run.costUsd = msg.total_cost_usd ?? null;
      run.durationMs = msg.duration_ms ?? 0;
      if (!run.ok) {
        const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
        run.error = errors || (msg.subtype === "success" ? msg.result : msg.subtype) || "error";
      }
    }
  }
} catch (e) {
  run.ok = false;
  run.error = e instanceof Error ? e.message : String(e);
}
// A model that answered in text instead of through structured output still answered: take
// the JSON when it is one the pack's schema accepts, so a stage is not lost to the channel.
if (run.ok && run.structured === null && run.text.trim().startsWith("{")) {
  try {
    const candidate = pack.answer.safeParse(JSON.parse(run.text));
    if (candidate.success) run.structured = candidate.data as Record<string, unknown>;
  } catch {}
}
if (run.error && /usage limit|rate limit/i.test(String(run.error))) run.rateLimited = true;
if (!run.durationMs) run.durationMs = Date.now() - t0;
if (run.ok && run.structured === null && !run.text) {
  run.ok = false;
  run.error = "no structured output";
}
finish(OUT, pack, run, luna.state);

/** The tool names behind a pack's allow-list: `Bash(git add:*)` and `Bash(npm:*)` are one `Bash`. */
export function toolNames(allowed: string[]): string[] {
  return [...new Set(allowed.map((t) => t.replace(/\(.*\)$/, "")))];
}

function skeleton() {
  return {
    schema: 3,
    ok: false,
    outcome: "fail",
    summary: "",
    needsInput: null,
    requested: [],
    findings: [],
    artifacts: [],
    slices: { done: 0, total: 0 },
    commit: null,
    answer: null,
    usage: { turns: 0, costUsd: null, durationMs: 0, model: "" },
    error: null,
    rateLimited: false,
    resetsAt: null,
    ledger: null,
    sessionId: null,
  };
}
