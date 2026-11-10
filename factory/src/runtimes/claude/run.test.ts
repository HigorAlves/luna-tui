// The Claude runtime's handling of the loop guard's stop, whichever way the SDK ends a query it aborts.
import { LOOP_STUCK } from "@hardness/contracts";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type ScriptStep, runScenario } from "../conformance/table.ts";
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
