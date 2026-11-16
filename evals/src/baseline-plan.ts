// The baseline run as one printed plan: the commands a person (or the main session) runs, in a fixed order. This prints text and runs nothing.
import { type Effort, EffortId, EngineId, type PackId, PACKS, effortProblem } from "@hardness/contracts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ENGINES = ["claude:haiku", "codex:luna", "jev"] as const;

/** `--efforts a,b`: low, medium or high, comma-separated. */
export function parseEfforts(raw: string): Effort[] {
  const efforts = raw.split(",").map((e) => EffortId.safeParse(e.trim()));
  if (efforts.length === 0 || efforts.some((e) => !e.success)) throw new Error("--efforts must be a list of low, medium or high");
  return efforts.map((e) => e.data!);
}

/** The agent packs that have eval cases under `evalsDir/<pack>/cases`, in PACKS order. */
export function agentPacksWithCases(evalsDir: string): PackId[] {
  return Object.values(PACKS).filter((p) => p.kind === "agent" && existsSync(join(evalsDir, p.id, "cases")) && readdirSync(join(evalsDir, p.id, "cases")).length > 0).map((p) => p.id);
}

/** The preflight, one `--save-baseline` run per decision pack and engine (PACKS order, then the engines given), then, with `efforts`, one per agent pack, engine and effort the engine supports, then the scorecard and the defaults commands. */
export function baselinePlan(options: { engines?: readonly string[]; efforts?: readonly Effort[]; agentPacks?: readonly PackId[] } = {}): string[] {
  const engines = options.engines ?? DEFAULT_ENGINES;
  const packs = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);
  return [
    "pnpm eval preflight",
    ...packs.flatMap((pack) => engines.map((engine) => `pnpm eval --pack ${pack} --engine ${engine} --save-baseline`)),
    ...(options.agentPacks ?? []).flatMap((pack) =>
      engines.flatMap((engine) => {
        const id = EngineId.safeParse(engine);
        return (options.efforts ?? []).filter((effort) => id.success && effortProblem(pack, id.data, effort) === null).map((effort) => `pnpm eval --pack ${pack} --engine ${engine} --effort ${effort} --save-baseline`);
      }),
    ),
    "pnpm eval scorecard",
    "pnpm eval defaults   # prints every proposal and writes nothing",
    "pnpm eval defaults --write --except triage_signals   # then take the packs that now have an entry out of UNMEASURED",
  ];
}
