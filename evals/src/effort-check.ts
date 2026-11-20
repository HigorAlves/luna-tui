// A run asked for an effort must report that effort back. A runner image built before `StageInput.effort` strips the unknown key,
// runs at the pack's own effort, and reports none or that one: a scorecard of those runs would be filed under the wrong effort.
import { type Effort, type EngineId, type PackId, type StageOutput, effortProblem, PACKS, visionProblem } from "@hardness/contracts";

import type { CaseResult } from "./grade.ts";

export const IGNORED_EFFORT = "the runner image does not honour --effort: rebuild it (pnpm images)";

/** The case result with a failing check added when the run was asked for `asked` and its `run.effort` differs or is missing; `ignored` says so, and `--save-baseline` must then be refused. */
export function honourEffort(asked: Effort | undefined, output: StageOutput | null, result: CaseResult): { result: CaseResult; ignored: boolean } {
  if (!asked || !output) return { result, ignored: false };
  const ran = output.run?.effort;
  if (ran === asked) return { result, ignored: false };
  const check = { check: `run.effort is ${asked}`, pass: false, detail: `${IGNORED_EFFORT} (${ran ? `ran at ${ran}` : "reported none"})` };
  return { result: { ...result, pass: false, checks: [...result.checks, check] }, ignored: true };
}

/** The first reason an engine of the run (`--engine`, then `--against`) cannot run the pack at the effort asked for, or null; checked before any container starts. */
export function effortProblems(pack: PackId, engines: EngineId[], asked: Effort | undefined): string | null {
  if (!asked) return null;
  for (const engine of engines) {
    const problem = effortProblem(pack, engine, asked);
    if (problem) return `${engine}: ${problem}`;
  }
  return null;
}

/** Why an engine cannot run a pack that reads images, for the first such engine, or null (RFC 0013). */
export function visionProblems(pack: PackId, engines: EngineId[]): string | null {
  for (const engine of engines) {
    const problem = visionProblem(PACKS[pack], engine);
    if (problem) return problem;
  }
  return null;
}
