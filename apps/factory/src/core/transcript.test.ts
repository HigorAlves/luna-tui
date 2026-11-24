import type { RunEvent } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { callLine } from "./render.ts";
import { transcriptLine } from "./transcript.ts";

describe("transcriptLine", () => {
  it.each<[RunEvent, string | null]>([
    [{ kind: "session", payload: { id: "s1", model: "m", text: "session s1 · model m" } }, "session s1 · model m"],
    [{ kind: "text", payload: { text: "Looking around first." } }, "Looking around first."],
    [{ kind: "tool_call", payload: { tool: "Bash", target: "git push origin HEAD", allowed: false, reason: "no" } }, "→ Bash git push origin HEAD"],
    [{ kind: "tool_call", payload: { tool: "slice_list", target: "", allowed: true } }, "→ slice_list"],
    [{ kind: "tool_call", payload: { tool: "Edit", target: "/work/a.ts", fingerprint: "1a2b3c4d", allowed: true } }, "→ Edit /work/a.ts ·1a2b3c4d"],
    [{ kind: "tool_result", payload: { tool: "bash", ok: false, error: "rejected: git push is not allowed" } }, "  ✗ bash rejected: git push is not allowed"],
    [{ kind: "tool_result", payload: { tool: "bash", ok: false, error: "failed: " } }, "  ✗ bash failed:"],
    [{ kind: "tool_result", payload: { tool: "Bash", ok: false } }, null],
    [{ kind: "tool_result", payload: { tool: "Bash", ok: true } }, null],
    [{ kind: "step", payload: { label: "reading", n: 1, of: 3 } }, "· reading (1/3)"],
    [{ kind: "step", payload: { label: "reading", n: 0, of: 0 } }, "· reading"],
    [{ kind: "usage", payload: { model: "m", inputTokens: 1 } }, null],
    [{ kind: "rate_limit", payload: { resetsAt: 1 } }, null],
    [{ kind: "ledger.init", payload: { total: 1 } }, null],
    [{ kind: "note", payload: { phase: "stage_end" } }, null],
    [{ kind: "child", payload: { phase: "start", runId: "child-1", pack: "verifying", role: "security-reviewer", engine: "codex:sol" } }, "↳ security-reviewer on codex:sol"],
    [{ kind: "child", payload: { phase: "end", runId: "child-1", pack: "verifying", role: "security-reviewer", engine: "codex:sol", ok: true, costUsd: 0.125 } }, "↳ security-reviewer on codex:sol answered · $0.1250"],
    [{ kind: "child", payload: { phase: "end", runId: "child-1", pack: "verifying", role: "security-reviewer", engine: "codex:sol", ok: true, costUsd: null } }, "↳ security-reviewer on codex:sol answered"],
    [{ kind: "child", payload: { phase: "end", runId: "child-1", pack: "verifying", role: "security-reviewer", engine: "codex:sol", ok: false, error: "no Codex login in this stage" } }, "↳ security-reviewer on codex:sol failed: no Codex login in this stage"],
  ])("%j prints %j", (event, line) => {
    expect(transcriptLine(event)).toBe(line);
  });

  it("prints a call the way callLine always has", () => {
    const input = { file_path: "/work/a.ts", old_string: "a", new_string: "b" };
    expect(callLine("Edit", input)).toMatch(/^→ Edit \/work\/a\.ts ·[0-9a-f]{8}$/);
  });
});
