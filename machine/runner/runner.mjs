// Runs one stage inside its container.
//   in:  /in/stage.json, a StageInput from the machine (has `pack`)
//   out: /out/result.json, written by `orc-stage run` (the StageOutput contract)
//   cwd: /work, the task's worktree
// Stdout is a readable transcript; the herdr watch pane follows it with `docker logs -f`.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const input = JSON.parse(readFileSync("/in/stage.json", "utf8"));

if (input.pack) {
  let ref = "unknown";
  try {
    ref = readFileSync("/orc/.orc-ref", "utf8").trim();
  } catch {}
  process.stdout.write(`orc ${ref} · pack ${input.pack} (attempt ${input.attempt})\n`);
  const child = spawn(
    "orc-stage",
    ["run", "--in", "/in/stage.json", "--out", "/out", "--plugin-root", "/orc"],
    { cwd: "/work", stdio: "inherit", env: { ...process.env, ORC_FACTORY: "1" } },
  );
  child.on("error", (error) => {
    process.stderr.write(`orc-stage failed to start: ${error.message}\n`);
    process.exit(127);
  });
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
} else {
  await legacy(input);
}

/**
 * DEPRECATED: the single-prompt path, for stage inputs without a `pack`
 * ({ stage, attempt, prompt, tools, maxTurns, schema }). Remove once nothing writes them.
 */
async function legacy(input) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const output = {
    ok: false,
    structured: null,
    result: null,
    error: null,
    rateLimited: false,
    resetsAt: null,
    turns: 0,
    costUsd: null,
    durationMs: null,
  };

  const say = (text) => process.stdout.write(`${text}\n`);
  const target = (tool) => {
    const i = tool.input ?? {};
    return String(i.file_path ?? i.command ?? i.pattern ?? i.path ?? "").slice(0, 160);
  };

  say(`▶ ${input.stage} (attempt ${input.attempt}) · tools: ${input.tools.join(", ")}`);

  try {
    for await (const message of query({
      prompt: input.prompt,
      options: {
        cwd: "/work",
        // The stage's tool set, all pre-approved; anything else is denied without asking.
        tools: input.tools,
        allowedTools: input.tools,
        permissionMode: "dontAsk",
        // Never load settings, hooks or MCP servers from the repo or the image.
        settingSources: [],
        maxTurns: input.maxTurns,
        ...(input.model ? { model: input.model } : {}),
        outputFormat: { type: "json_schema", schema: input.schema },
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) say(block.text.trim());
          if (block.type === "tool_use") say(`  → ${block.name} ${target(block)}`);
        }
      } else if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info ?? {};
        output.resetsAt = info.resetsAt ?? null;
        if (info.status && info.status !== "allowed") {
          output.rateLimited = true;
          say(`⚠ usage limit (${info.status}), resets ${new Date((info.resetsAt ?? 0) * 1000).toISOString()}`);
        }
      } else if (message.type === "result") {
        // A failed login still reports subtype "success", so is_error decides.
        output.ok = message.subtype === "success" && !message.is_error;
        output.result = message.result ?? null;
        output.structured = message.structured_output ?? null;
        output.turns = message.num_turns ?? 0;
        output.costUsd = message.total_cost_usd ?? null;
        output.durationMs = message.duration_ms ?? null;
        if (!output.ok) output.error = message.result || message.subtype;
      }
    }
  } catch (error) {
    output.error = String(error?.message ?? error);
  }

  if (!output.ok && /usage limit|rate limit/i.test(output.error ?? "")) output.rateLimited = true;
  writeFileSync("/out/result.json", JSON.stringify(output, null, 2));
  say(output.ok ? `✓ ${input.stage} done in ${output.turns} turns` : `✗ ${input.stage} failed: ${output.error}`);
}
