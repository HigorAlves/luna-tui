// The eve runtime against the conformance table, on eve's mockModel playing the script inside a
// real built eve server: the agent is compiled with the scripted model and built once here.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

import { compileAndBuild } from "../eve/build.ts";
import { eveRuntime } from "../eve/run.ts";
import { PACK, conformance } from "./table.ts";

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
  { resetsAt: false, schemaIssue: false, tools: true, text: true },
  { timeoutMs: 60_000 },
);
