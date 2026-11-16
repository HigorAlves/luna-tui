// The Claude runtime's handling of the loop guard's stop, whichever way the SDK ends a query it aborts.
import { LOOP_STUCK } from "@hardness/contracts";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AGENT_TABLE, type ScriptStep, runScenario } from "../conformance/table.ts";
import { scriptedQuery } from "./fake.ts";
import { type Transport, claudeRuntime } from "./run.ts";

const LOOPING = { mode: "on", judge: false, envelope: 8, judgeConfidence: 0.7, redirects: 1, backstopMult: 2.5 } as const;
const script: ScriptStep[] = Array.from({ length: 80 }, (_, i): ScriptStep =>
  i % 2 === 0 ? { call: "bash", command: "pnpm test", fails: "FAIL\nAssertionError: expected 1 to be 2" } : { call: "bash", command: "sed -i s/1/2/ src/a.ts" },
);

/** The scripted query, but a query the abort ends by returning, with no result and no throw. */
const endsCleanly = (): Transport => (params: { prompt: string; options?: Options }): Query => {
  const inner = scriptedQuery(script)(params);
  async function* play() {
    try {
      yield* inner;
    } catch (e) {
      if (!params.options?.abortController?.signal.aborted) throw e;
    }
  }
  return play() as unknown as Query;
};

async function run(transport: Transport) {
  const root = mkdtempSync(join(tmpdir(), "stop-"));
  try {
    return await runScenario(claudeRuntime(transport), "claude:sonnet", root, undefined, undefined, undefined, { guard: LOOPING });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the loop guard's stop", () => {
  it("ends the run with its reason when the abort throws out of the stream", async () => {
    const { run: outcome, events } = await run(scriptedQuery(script));
    expect(outcome).toMatchObject({ ok: false, rateLimited: false, error: expect.stringContaining(LOOP_STUCK) });
    expect(events.filter((e) => e.kind === "tool_result")).toHaveLength(40);
  });

  it("ends the run with its reason when the abort ends the stream with no result", async () => {
    const { run: outcome } = await run(endsCleanly());
    expect(outcome).toMatchObject({ ok: false, rateLimited: false, error: expect.stringContaining(LOOP_STUCK) });
  });
});

describe("a call the SDK's own rules refuse", () => {
  const DENIED = "Permission to use Bash has been denied because Claude Code is running in don't ask mode";
  const refusing = (hookFirst: boolean): Transport => (params) => {
    async function* play() {
      yield { type: "system", subtype: "init", session_id: "s", model: "m", skills: [], plugins: [] };
      yield { type: "assistant", session_id: "s", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status --short" } }] } };
      if (hookFirst) {
        // The guard's hook sees the call before the SDK's rules do, and lets it pass.
        await params.options?.hooks?.PreToolUse?.[0]?.hooks[0]?.({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status --short" }, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/work" } as never, "t1", { signal: new AbortController().signal });
      }
      yield { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t1", message: DENIED, uuid: "u", session_id: "s" };
      yield { type: "user", session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: DENIED }], is_error: true }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: AGENT_TABLE.valid, num_turns: 2, duration_ms: 1, total_cost_usd: 0, session_id: "s" };
    }
    return play() as unknown as Query;
  };

  it("is logged as refused with the SDK's reason, and its failed result says why", async () => {
    const root = mkdtempSync(join(tmpdir(), "denied-"));
    try {
      const { events } = await runScenario(claudeRuntime(refusing(false)), "claude:sonnet", root);
      expect(events.filter((e) => e.kind === "tool_call")).toEqual([{ kind: "tool_call", payload: expect.objectContaining({ tool: "Bash", allowed: false, reason: DENIED }) }]);
      expect(events.filter((e) => e.kind === "tool_result")).toEqual([{ kind: "tool_result", payload: expect.objectContaining({ ok: false, error: DENIED }) }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still tells why on the result when the guard had already let the call pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "denied-"));
    try {
      const { events } = await runScenario(claudeRuntime(refusing(true)), "claude:sonnet", root);
      expect(events.filter((e) => e.kind === "tool_result")).toEqual([{ kind: "tool_result", payload: expect.objectContaining({ ok: false, error: DENIED }) }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the run's token count", () => {
  /** The scripted query, with a usage on its result as the SDK gives it. */
  const withUsage = (usage: unknown): Transport => (params) => {
    const inner = scriptedQuery([{ answer: AGENT_TABLE.valid }])(params);
    async function* play() {
      for await (const msg of inner) yield msg.type === "result" ? ({ ...msg, usage } as typeof msg) : msg;
    }
    return play() as unknown as Query;
  };

  it("prices cache writes by their lifetime when the result carries the split", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-"));
    try {
      const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 } };
      const { run: outcome } = await runScenario(claudeRuntime(withUsage(usage)), "claude:sonnet", root);
      expect(outcome.tokens).toEqual({ input: 4100, output: 20, cached: 5000, cacheWrite5m: 1000, cacheWrite1h: 3000 });
      const flat = await runScenario(claudeRuntime(withUsage({ ...usage, cache_creation: null })), "claude:sonnet", root);
      expect(flat.run.tokens).toEqual({ input: 4100, output: 20, cached: 5000, cacheWrite5m: 4000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
