// A repo's own checks from its luna.yaml: which of them a change calls for, and how each
// runs. Pure; the verifying stage and the setup proof run what this returns.
import type { CheckSpec } from "@hardness/contracts";
import picomatch from "picomatch";

/** The checks a change calls for: one with `paths` only when a changed file matches one of
 *  them, one without always. An unknown change (null) keeps every check, never skipping by accident. */
export function selectChecks(checks: CheckSpec[], changedPaths: string[] | null): CheckSpec[] {
  if (changedPaths === null) return checks;
  return checks.filter((check) => {
    if (!check.paths || check.paths.length === 0) return true;
    const matches = picomatch(check.paths, { dot: true });
    return changedPaths.some((path) => matches(path));
  });
}

/** Why a check with `paths` was left out, for the report. */
export const skippedReason = (check: CheckSpec): string => `no change under ${(check.paths ?? []).join(", ")}`;

export interface CheckCommand {
  name: string;
  /** The line as a person reads it, with its directory. */
  cmd: string;
  /** What to exec: the line through `sh`, in `cwd` relative to the worktree. */
  argv: string[];
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** The check as a command: `sh -c` so the line can be anything a person would type. */
export function checkCommand(check: CheckSpec): CheckCommand {
  const cwd = check.cwd && check.cwd !== "." ? check.cwd : null;
  return {
    name: check.name,
    cmd: cwd ? `${check.run} (in ${cwd})` : check.run,
    argv: ["sh", "-c", cwd ? `cd ${quote(cwd)} && ${check.run}` : check.run],
  };
}
