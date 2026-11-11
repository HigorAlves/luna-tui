import { describe, expect, it } from "vitest";

import { RunEvent, isStreamEvent } from "./index.ts";

describe("RunEvent", () => {
  it.each([
    { kind: "text", payload: { text: "Looking around first." } },
    { kind: "tool_call", payload: { id: "toolu_1", tool: "Bash", target: "git push origin HEAD", allowed: false, reason: "git push is not allowed" } },
    { kind: "tool_call", payload: { tool: "Edit", target: "/work/a.ts", fingerprint: "1a2b3c4d", allowed: true } },
    { kind: "tool_result", payload: { id: "toolu_1", tool: "Bash", ok: false, error: "rejected: git push is not allowed" } },
    { kind: "tool_result", payload: { id: "toolu_2", tool: "Bash", ok: false, observation: { intent: "test", errorClass: "command_not_found", failure: "a1b2c3d4e5" } } },
    { kind: "economy.guard", payload: { action: "redirect", calls: 24, cause: "repeating_failure", failure: "a1b2c3d4e5", confidence: 0.9 } },
    { kind: "step", payload: { label: "writing the test", n: 2, of: 5 } },
    { kind: "usage", payload: { model: "claude-sonnet-5-5", inputTokens: 1200, outputTokens: 80, costUsd: 0.01 } },
    { kind: "rate_limit", payload: { resetsAt: 1_900_000_000 } },
    { kind: "session", payload: { id: "s1", model: "claude-sonnet-5-5", text: "session s1 · model claude-sonnet-5-5" } },
    { kind: "note", payload: { phase: "stage_end", outcome: "pass", pack: "implementing" } },
    { kind: "ledger.init", payload: { total: 3 } },
    { kind: "slice.committed", payload: { id: 1, title: "parse", commit: "abc" } },
    { kind: "escalation", payload: { id: 2, title: "wire", commit: null } },
    { kind: "child", payload: { phase: "start", runId: "r2", pack: "triage", engine: "codex:sol" } },
    { kind: "child", payload: { phase: "end", runId: "r2", pack: "triage", engine: "codex:sol", ok: true, costUsd: 0.2 } },
  ])("accepts a $kind event", (event) => {
    expect(RunEvent.safeParse(event).error).toBeUndefined();
  });

  it("refuses a tool call without the guard's decision, and a kind it does not know", () => {
    expect(RunEvent.safeParse({ kind: "tool_call", payload: { tool: "Bash", target: "ls" } }).success).toBe(false);
    expect(RunEvent.safeParse({ kind: "tool_output", payload: {} }).success).toBe(false);
  });

  it("refuses a tool result whose observation carries text, and a guard action it does not know", () => {
    expect(RunEvent.safeParse({ kind: "tool_result", payload: { tool: "Bash", ok: true, observation: { output: "secret" } } }).success).toBe(false);
    expect(RunEvent.safeParse({ kind: "economy.guard", payload: { action: "kill", calls: 1 } }).success).toBe(false);
  });

  it("tells the run's own stream from the events the task's log keeps", () => {
    expect(["text", "tool_call", "tool_result", "usage", "rate_limit", "session", "child"].every((kind) => isStreamEvent({ kind }))).toBe(true);
    expect(["economy.guard", "step", "note", "ledger.init", "slice.red", "escalation", "something.new"].some((kind) => isStreamEvent({ kind }))).toBe(false);
  });
});
