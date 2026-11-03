// The eve runtime against the conformance table, on eve's mockModel playing the script inside a
// real built eve server: the agent is compiled with the scripted model and built once here.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { compileAndBuild } from "../eve/build.ts";
import { eveRuntime } from "../eve/run.ts";
import { GOLDEN, PACK, conformance, masked, runScenario } from "./table.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Inside the factory, as the real agents are, so the build resolves eve from its node_modules.
const agentsDir = mkdtempSync(join(FACTORY_ROOT, ".eve-agents-conformance-"));

beforeAll(() => {
  compileAndBuild(PACK, { factoryRoot: FACTORY_ROOT, outDir: agentsDir, model: "scripted" });
}, 180_000);
afterAll(() => rmSync(agentsDir, { recursive: true, force: true }));

conformance(
  "eve",
  "codex:luna",
  (script) => {
    const file = join(agentsDir, `script-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(script));
    return eveRuntime({ agentsDir, serverEnv: { LUNA_EVE_SCRIPT: file } });
  },
  { resetsAt: false, schemaIssue: false, tools: true, text: true, delegate: false },
  { timeoutMs: 60_000 },
);

it("the eve runtime's transcript of the golden run", async () => {
  const file = join(agentsDir, "script-golden.json");
  writeFileSync(file, JSON.stringify(GOLDEN));
  const root = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const { transcript, events } = await runScenario(eveRuntime({ agentsDir, serverEnv: { LUNA_EVE_SCRIPT: file } }), "codex:luna", root);
    // The step's own line comes from the luna bridge, which races the session's stream: it is
    // checked apart from the order.
    expect(masked(transcript).filter((line) => !line.startsWith("· "))).toEqual([
      "session <id> · eve agent implementing · chatgpt(gpt-6-luna-fast)",
      "Looking around first.",
      "→ step reading the code",
      "→ bash git push origin HEAD",
      "  ✗ bash rejected: git push is not allowed in a stage: the machine pushes after approval",
      "→ bash pwd",
      "→ slice_init",
    ]);
    expect(transcript).toContain("· reading the code (1/3)");
    // The events behind it: every call with the approval's decision.
    expect(events.flatMap((e) => (e.kind === "tool_call" ? [[e.payload.tool, e.payload.target, e.payload.allowed]] : []))).toEqual([
      ["step", "reading the code", true],
      ["bash", "git push origin HEAD", false],
      ["bash", "pwd", true],
      ["slice_init", "", true],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
