import { isControlPlane } from "./control-plane.ts";
import { isTestFile } from "./graph-impact.ts";

const LIMITS = { in_place: { files: 10, lines: 200 }, re_verify_partial: { files: 30, lines: 600 } } as const;

export interface FixGuardInput {
  scope: "in_place" | "re_verify_partial";
  /** `git diff --no-renames -z --name-only` between the commit the fix started from and the fix. */
  changed: string[];
  /** The files the PR already changes. */
  prFiles: string[];
  /** `git diff --no-renames -z --numstat` totals. */
  added: number;
  removed: number;
  /** The files numstat shows as binary (`-`): their lines cannot be counted, so they count as over the size cap. */
  binary?: string[];
}

export type FixGuardResult = { ok: true } | { ok: false; reason: string; paths: string[] };

/** A fix may touch only files the PR already changes and test files, never a control-plane path, and stays within the size of its scope. Pure. */
export function fixGuard(input: FixGuardInput): FixGuardResult {
  const control = input.changed.filter(isControlPlane);
  if (control.length > 0) return { ok: false, paths: control, reason: `the fix touches a control-plane path: ${control.slice(0, 5).join(", ")}` };
  const own = new Set(input.prFiles);
  const outside = input.changed.filter((p) => !own.has(p) && !isTestFile(p));
  if (outside.length > 0) return { ok: false, paths: outside, reason: `the fix touches files the PR does not change: ${outside.slice(0, 5).join(", ")}` };
  const limit = LIMITS[input.scope];
  if ((input.binary ?? []).length > 0) return { ok: false, paths: input.binary!.slice(0, 10), reason: `the fix changes a binary file, whose size cannot be counted (${input.binary!.slice(0, 5).join(", ")})` };
  if (input.changed.length > limit.files) return { ok: false, paths: input.changed.slice(0, 10), reason: `the fix changes ${input.changed.length} files (at most ${limit.files} for ${input.scope})` };
  const lines = input.added + input.removed;
  if (lines > limit.lines) return { ok: false, paths: input.changed.slice(0, 10), reason: `the fix changes ${lines} lines (at most ${limit.lines} for ${input.scope})` };
  return { ok: true };
}
