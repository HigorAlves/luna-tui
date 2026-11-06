// The baseline run as one printed plan: the commands a person (or the main session) runs, in a fixed order. This prints text and runs nothing.
import { PACKS } from "@hardness/contracts";

export const DEFAULT_ENGINES = ["claude:haiku", "codex:luna", "jev"] as const;

/** The preflight, one `--save-baseline` run per decision pack and engine (PACKS order, then the engines given), then the scorecard and the defaults commands. */
export function baselinePlan(options: { engines?: readonly string[] } = {}): string[] {
  const engines = options.engines ?? DEFAULT_ENGINES;
  const packs = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);
  return [
    "pnpm eval preflight",
    ...packs.flatMap((pack) => engines.map((engine) => `pnpm eval --pack ${pack} --engine ${engine} --save-baseline`)),
    "pnpm eval scorecard",
    "pnpm eval defaults   # prints every proposal and writes nothing",
    "pnpm eval defaults --write --except triage_signals   # then take the packs that now have an entry out of UNMEASURED",
  ];
}
