// A helper on an eve engine is the stage's native subagent: the eve runtime against a real built
// server whose subagent plays its own script (LUNA_EVE_SCRIPT_<ROLE>) on eve's mockModel. Not part
// of the table: no other runtime has a native subagent. The `delegate` rows of the table (the
// bridge path) are in eve.test.ts.
import { type AgentPack, PACKS } from "@hardness/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileAndBuild } from "../eve/build.ts";
import { eveRuntime } from "../eve/run.ts";
import { type ScriptStep, type TablePack, runScenario } from "./table.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const agentsDir = mkdtempSync(join(FACTORY_ROOT, ".eve-agents-subagents-"));
const HELPER = { role: "reply-drafter", engine: "codex:luna" } as const;
const PACK: AgentPack = { ...PACKS.implementing, helpers: [HELPER] };
const DONE = { kind: "done", summary: "did it" };
const TABLE: TablePack = { pack: PACK, valid: DONE, expected: DONE, off: { kind: "maybe", summary: "x" } };
const ANSWER = { answer: "Use the export button." };

// The runner checks the helper's Codex login before it starts the child.
const codexHome = mkdtempSync(join(tmpdir(), "subagent-codex-"));
const was = process.env.CODEX_HOME;
beforeAll(() => {
  writeFileSync(join(codexHome, "auth.json"), "{}");
  process.env.CODEX_HOME = codexHome;
  compileAndBuild(PACK, { factoryRoot: FACTORY_ROOT, outDir: agentsDir, model: "scripted" });
}, 180_000);
afterAll(() => {
  if (was === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = was;
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

const play = (parent: ScriptStep[], child: ScriptStep[]) => {
  const write = (name: string, script: ScriptStep[]) => {
    const file = join(agentsDir, `${name}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(script));
    return file;
  };
  return eveRuntime({ agentsDir, serverEnv: { LUNA_EVE_SCRIPT: write("parent", parent), LUNA_EVE_SCRIPT_REPLY_DRAFTER: write("child", child) } });
};
const ASK: ScriptStep = { call: "delegate", helper: HELPER.role, message: "Draft the answer to the question" };

const ids = { runId: "child-1", pack: "implementing", role: HELPER.role, engine: HELPER.engine };

/** Runs one scenario in a fresh folder and hands the result to `check`. */
async function scenario(parent: ScriptStep[], child: ScriptStep[], check: (result: Awaited<ReturnType<typeof runScenario>>) => void) {
  const root = mkdtempSync(join(tmpdir(), "subagent-"));
  try {
    check(await runScenario(play(parent, child), "codex:luna", root, TABLE, 60_000));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("eve native subagent", () => {
  it("answers through the delegate tool: the helper's answer is the result, its child events in order, its folder written", async () => {
    await scenario([ASK, { answer: DONE, echo: true }], [{ answer: ANSWER }], ({ run, events, out, transcript }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toBe(JSON.stringify(ANSWER));
      const children = events.filter((e) => e.kind === "child");
      expect(children).toEqual([
        { kind: "child", payload: { phase: "start", ...ids } },
        { kind: "child", payload: { phase: "end", ...ids, ok: true, costUsd: null } },
      ]);
      const [start, end] = children.map((c) => events.indexOf(c)) as [number, number];
      const call = events.findIndex((e) => e.kind === "tool_call" && e.payload.tool === "delegate" && e.payload.target === HELPER.role);
      const result = events.findIndex((e) => e.kind === "tool_result" && e.payload.tool === "delegate");
      expect([call < start, start < end, end < result]).toEqual([true, true, true]);
      expect(events.find((e) => e.kind === "tool_result" && e.payload.tool === "delegate")?.payload).toMatchObject({ ok: true });
      const folder = join(out, "children", "1");
      expect(readFileSync(join(folder, "prompt.md"), "utf8")).toContain("Draft the answer to the question");
      expect(JSON.parse(readFileSync(join(folder, "result.json"), "utf8"))).toMatchObject({ ok: true, answer: ANSWER });
      expect(readFileSync(join(folder, "events.jsonl"), "utf8")).toContain('"kind":"usage"');
      expect(transcript).toContain(`→ delegate ${HELPER.role}`);
      expect(existsSync(join(out, "children", "2"))).toBe(false);
    });
  });

  it("counts the child's spend once: eve puts it on the parent's stream, so the runner adds none of its own", async () => {
    await scenario([ASK, { answer: DONE }], [{ answer: ANSWER }], ({ run, events, out }) => {
      const usage = (e: { kind: string; payload?: unknown }) => e.kind === "usage";
      const parent = events.filter(usage).map((e) => (e as { payload: { inputTokens?: number; outputTokens?: number } }).payload);
      const childEvents = readFileSync(join(out, "children", "1", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; payload: { inputTokens?: number; outputTokens?: number } });
      const spent = childEvents.find(usage)!.payload;
      // The child's own call is among the usage the parent's stream carried, once.
      expect(parent.filter((u) => u.inputTokens === spent.inputTokens && u.outputTokens === spent.outputTokens)).toHaveLength(1);
      // And the run's total is that stream's: the parent's two calls and the child's one.
      expect(run.turns).toBe(2);
      expect(run.tokens?.input).toBe(parent.reduce((n, u) => n + (u.inputTokens ?? 0), 0));
      expect(parent).toHaveLength(3);
    });
  });

  it("cancels a child that never answers at its cap, and the parent goes on and answers", async () => {
    // The stage has 8 turns and has used 1: the child gets 6 (one is kept for the parent) and keeps asking for the shell.
    await scenario([ASK, { answer: DONE, echo: true }], [{ call: "bash", command: "git log" }], ({ run, events, out }) => {
      expect(run.ok).toBe(true);
      // The tool says only that the child was cancelled; the cap is in its end event and folder.
      expect(run.structured?.summary).toMatch(/reply-drafter gave no answer \(cancelled\)\. Go on without it/);
      expect(events.find((e) => e.kind === "tool_result" && e.payload.tool === "delegate")?.payload).toMatchObject({ ok: false });
      expect(events.filter((e) => e.kind === "child").at(-1)?.payload).toMatchObject({ phase: "end", ok: false, error: expect.stringMatching(/within 6 model calls/) });
      const result = JSON.parse(readFileSync(join(out, "children", "1", "result.json"), "utf8"));
      expect(result).toMatchObject({ ok: false, usage: { turns: expect.any(Number) } });
      expect(result.usage.turns).toBeGreaterThanOrEqual(6);
    });
  }, 90_000);
});
