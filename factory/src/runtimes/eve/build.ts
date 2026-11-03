// Compiles every agent pack an eve engine may run into an eve app and runs `eve build` in each,
// so a stage starts a ready server; a pack no eve engine may run gets no agent. The runner image runs this at build time (machine/runner/Dockerfile); no model
// call and no Docker daemon is needed. Usage: node src/runtimes/eve/build.ts [outDir] [pack...]
import { type AgentPack, PACKS, resolveEngine } from "@hardness/contracts";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type CompileOptions, compileAgent } from "./compile.ts";

/** Runs `eve build` in a compiled app; throws with eve's output when it fails. */
export function buildAgent(app: string, factoryRoot: string): void {
  const built = spawnSync(join(factoryRoot, "node_modules", ".bin", "eve"), ["build"], {
    cwd: app,
    env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`eve build failed in ${app}:\n${built.stdout}\n${built.stderr}`);
}

/** Compiles and builds `pack`; returns the app folder. */
export function compileAndBuild(pack: AgentPack, options: CompileOptions): string {
  const app = compileAgent(pack, options);
  buildAgent(app, options.factoryRoot);
  return app;
}

/** The agent packs an eve engine may run (of `only`, when given): the ones the image builds. */
export function evePacks(only: string[] = []): AgentPack[] {
  return Object.values(PACKS).filter(
    (p): p is AgentPack =>
      p.kind === "agent" && p.agent !== null && p.engines.allowed.some((id) => resolveEngine(id).runtime === "eve") && (only.length === 0 || only.includes(p.id)),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const factoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const [outArg, ...only] = process.argv.slice(2);
  const outDir = resolve(outArg ?? join(factoryRoot, ".eve-agents"));
  for (const pack of evePacks(only)) {
    const t0 = Date.now();
    compileAndBuild(pack, { factoryRoot, outDir });
    process.stdout.write(`eve agent ${pack.id} built in ${Date.now() - t0} ms\n`);
  }
}
