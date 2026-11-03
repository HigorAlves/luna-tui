// The Claude runtime against the conformance table, on a scripted query() in place of the SDK's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { claudeRuntime } from "../claude/run.ts";
import { scriptedQuery } from "../claude/fake.ts";
import { GOLDEN, conformance, masked, runScenario } from "./table.ts";

conformance("claude", "claude:sonnet", (script) => claudeRuntime(scriptedQuery(script)), { resetsAt: true, schemaIssue: true, tools: true, text: true });

it("the Claude runtime's transcript of the golden run", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const { transcript } = await runScenario(claudeRuntime(scriptedQuery(GOLDEN)), "claude:sonnet", root);
    expect(masked(transcript)).toEqual([
      "session <id> · model claude-sonnet-5-5 · skills 0 · plugins none",
      "Looking around first.",
      "→ mcp__luna__step reading the code",
      "· reading the code (1/3)",
      "→ Bash git push origin HEAD",
      "→ Bash pwd",
      "→ mcp__luna__slice_init",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
