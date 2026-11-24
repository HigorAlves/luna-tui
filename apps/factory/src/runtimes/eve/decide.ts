// The eve app every decision pack runs on (RFC 0005 rule 1): one agent with no tools, no skills and
// no role, whose instructions only say how to answer. The questions arrive as the session's message
// (core/decide.ts) and the answer schema as its output schema, so one build serves every decision
// pack on every eve engine.
import { PACKS } from "@hardness/contracts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DECIDE_APP, EVE_VERSION, GENERATED, type CompileOptions, importPath, usageLimit } from "./compile.ts";

export { DECIDE_APP };

const INSTRUCTIONS = "You answer typed questions about a software ticket for an automated pipeline. Reply only with the JSON object the schema asks for; be calibrated and terse.\n";

/** Every file of the decide app, by path relative to the app: what agentFiles gives an agent, less its tools and skills. */
export function decideFiles(options: CompileOptions): Record<string, string> {
  const app = join(options.outDir, DECIDE_APP);
  const lib = join(options.factoryRoot, "src", "runtimes", "eve");
  const fromAgent = (file: string) => importPath(join(app, "agent"), join(lib, file));
  const model =
    options.model === "scripted"
      ? { line: `import { scriptedModel } from "${fromAgent("fake.ts")}";`, expr: "scriptedModel()" }
      : { line: `import { stageModel } from "${fromAgent("agent/model.ts")}";`, expr: "stageModel()" };
  const agent = [
    `// ${GENERATED} The decide app: every decision pack.`,
    `import { defineAgent } from "eve";`,
    model.line,
    "",
    "export default defineAgent({",
    `  model: ${model.expr},`,
    `  reasoning: "low",`,
    "  defaultTools: false,",
    `  limits: { sessionUsage: ${usageLimit({ maxTurns: Math.max(...Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.maxTurns)) })} },`,
    "});",
    "",
  ].join("\n");
  return {
    "package.json": `${JSON.stringify({ name: `luna-${DECIDE_APP}`, private: true, type: "module", description: GENERATED, dependencies: { eve: EVE_VERSION } }, null, 2)}\n`,
    "agent/agent.ts": agent,
    "agent/instructions.md": INSTRUCTIONS,
    "agent/channels/eve.ts": `export { default } from "${importPath(join(app, "agent", "channels"), join(lib, "agent", "channel.ts"))}";\n`,
    "agent/sandbox.ts": `export { default, environment } from "${fromAgent("sandbox.ts")}";\n`,
  };
}

/** Writes the decide app afresh; returns its folder. */
export function compileDecide(options: CompileOptions): string {
  const app = join(options.outDir, DECIDE_APP);
  rmSync(join(app, "agent"), { recursive: true, force: true });
  for (const [rel, body] of Object.entries(decideFiles(options))) {
    mkdirSync(dirname(join(app, rel)), { recursive: true });
    writeFileSync(join(app, rel), body);
  }
  return app;
}
