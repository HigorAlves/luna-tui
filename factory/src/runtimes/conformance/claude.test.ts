// The Claude runtime against the conformance table, on a scripted query() in place of the SDK's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { claudeRuntime } from "../claude/run.ts";
import { scriptedQuery } from "../claude/fake.ts";
import { CAPS_NO_TOOLS, DECISION_TABLE } from "./decision.ts";
import { GOLDEN, conformance, masked, runScenario } from "./table.ts";

conformance("claude", "claude:sonnet", (script) => claudeRuntime(scriptedQuery(script)), { resetsAt: true, schemaIssue: true, tools: true, text: true, delegate: true });
conformance("claude (decide)", "claude:haiku", (script) => claudeRuntime(scriptedQuery(script)), { resetsAt: true, schemaIssue: true, ...CAPS_NO_TOOLS }, { table: DECISION_TABLE });

it("the Claude runtime's transcript of the golden run", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const { transcript, events } = await runScenario(claudeRuntime(scriptedQuery(GOLDEN)), "claude:sonnet", root);
    expect(masked(transcript)).toEqual([
      "session <id> · model claude-sonnet-5-5 · skills 0 · plugins none",
      "Looking around first.",
      "→ mcp__luna__step reading the code",
      "· reading the code (1/3)",
      "→ Bash git push origin HEAD",
      "→ Bash pwd",
      "→ mcp__luna__slice_init",
    ]);
    // The events behind it: every call with the guard's decision, then its result.
    expect(events.filter((e) => e.kind === "tool_call" || e.kind === "tool_result").map((e) => e.payload)).toEqual([
      { id: "toolu_1", tool: "mcp__luna__step", target: "reading the code", allowed: true },
      { id: "toolu_1", tool: "mcp__luna__step", ok: true },
      { id: "toolu_2", tool: "Bash", target: "git push origin HEAD", allowed: false, reason: expect.stringMatching(/git push is not allowed/) },
      { id: "toolu_2", tool: "Bash", ok: false },
      { id: "toolu_3", tool: "Bash", target: "pwd", allowed: true },
      { id: "toolu_3", tool: "Bash", ok: true },
      { id: "toolu_4", tool: "mcp__luna__slice_init", target: "", allowed: true },
      { id: "toolu_4", tool: "mcp__luna__slice_init", ok: true },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["session", "text", "tool_call", "step", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "ledger.init", "tool_result", "usage"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
