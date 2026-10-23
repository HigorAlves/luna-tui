// Runs one read-only "stage" with the Agent SDK against the repo mounted at /work.
// Streams every message to stdout (what a herdr watch pane would show) and writes a
// summary to /out/result.json so the orchestrator can read the outcome.
import { writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt =
  process.env.SPIKE_PROMPT ??
  "List the top-level files in this repository and describe the project in one sentence.";

const started = Date.now();
const summary = { ok: false, auth: authKind(), started_at: new Date(started).toISOString() };

function authKind() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "subscription-token";
  if (process.env.ANTHROPIC_API_KEY) return "api-key";
  return "none";
}

try {
  for await (const message of query({
    prompt,
    options: {
      cwd: "/work",
      allowedTools: ["Read", "Glob", "Grep"],
      maxTurns: 6,
    },
  })) {
    console.log(JSON.stringify(message));
    if (message.type === "result") {
      Object.assign(summary, {
        ok: message.subtype === "success" && !message.is_error,
        subtype: message.subtype,
        result: message.result,
        num_turns: message.num_turns,
        duration_ms: message.duration_ms,
        total_cost_usd: message.total_cost_usd,
        usage: message.usage,
      });
    }
  }
} catch (error) {
  summary.error = String(error?.message ?? error);
}

summary.wall_ms = Date.now() - started;
writeFileSync("/out/result.json", JSON.stringify(summary, null, 2));
console.error(`spike finished: ok=${summary.ok} auth=${summary.auth}`);
process.exit(summary.ok ? 0 : 1);
