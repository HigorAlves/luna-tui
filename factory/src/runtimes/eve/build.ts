// Compiles every agent pack an eve engine may run, and every helper on an eve engine (as its child
// run's pack), into an eve app and runs `eve build` in each, so a stage starts a ready server; a
// pack no eve engine may run gets no agent. The runner image runs this at build time
// (machine/runner/Dockerfile); no model call and no Docker daemon is needed. Usage: node src/runtimes/eve/build.ts [outDir] [pack...]
import { type AgentPack, type DecisionPack, PACKS, helperPack, helpersOn, resolveEngine } from "@hardness/contracts";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type CompileOptions, appName, compileAgent } from "./compile.ts";
import { compileDecide } from "./decide.ts";

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

/** Compiles and builds the decide app every decision pack on an eve engine runs on; returns the app folder. */
export function compileAndBuildDecide(options: CompileOptions): string {
  const app = compileDecide(options);
  buildAgent(app, options.factoryRoot);
  return app;
}

/** The agent packs an eve engine may run, and each helper on an eve engine of a stage on another
 *  runtime as its child run's pack (helperPack), of `only` when given (a pack's id, `<pack>--<role>`
 *  for a helper, or `decide`): the ones the image builds. */
export function evePacks(only: string[] = []): Array<AgentPack | DecisionPack> {
  const agents = Object.values(PACKS).filter((p): p is AgentPack => p.kind === "agent" && p.agent !== null);
  const own = agents.filter((p) => p.engines.allowed.some((id) => resolveEngine(id).runtime === "eve"));
  // A helper on an eve engine that a stage on another runtime reaches over the bridge, once per app.
  // An eve stage's own eve helpers are native subagents, compiled into its app.
  const helpers = new Map<string, AgentPack>();
  for (const p of agents) {
    for (const id of p.engines.allowed) {
      const runtime = resolveEngine(id).runtime;
      if (runtime === "eve") continue;
      for (const h of helpersOn(p, runtime)) {
        if (resolveEngine(h.engine).runtime !== "eve") continue;
        const run = helperPack(p, h);
        helpers.set(appName(run), run);
      }
    }
  }
  // One generic decide app serves every decision pack an eve engine may run: its first such pack stands for it.
  const decision = Object.values(PACKS).find((p): p is DecisionPack => p.kind === "decision" && p.engines.allowed.some((id) => resolveEngine(id).runtime === "eve"));
  return [...own, ...helpers.values(), ...(decision ? [decision] : [])].filter((p) => only.length === 0 || only.includes(appName(p)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const factoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const [outArg, ...only] = process.argv.slice(2);
  const outDir = resolve(outArg ?? join(factoryRoot, ".eve-agents"));
  for (const pack of evePacks(only)) {
    const t0 = Date.now();
    if (pack.kind === "decision") compileAndBuildDecide({ factoryRoot, outDir });
    else compileAndBuild(pack, { factoryRoot, outDir });
    process.stdout.write(`eve agent ${appName(pack)} built in ${Date.now() - t0} ms\n`);
  }
}
