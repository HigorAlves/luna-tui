// The core guards (core/guards.ts) as eve tool approvals: a refused call never starts and the model
// reads the reason (the spike's finding; eve's hooks fire only after the fact). The policy is the
// stage's, passed by the runner in LUNA_EVE_GUARD; without one every guarded call is refused.
import type { ApprovalStatus } from "eve/tools/approval";

import { type GuardContext, type GuardedCall, checkCall } from "../../../core/guards.ts";

function policy(): GuardContext {
  try {
    return JSON.parse(process.env.LUNA_EVE_GUARD ?? "") as GuardContext;
  } catch {
    return { writable: false, commands: [], workRoot: "/nonexistent", outRoot: "/nonexistent", roots: { scratch: "/nonexistent" } };
  }
}

/** How a native subagent's policy differs from the stage's: its child run is read-only, with its own commands. */
export type Narrowing = Pick<GuardContext, "writable" | "commands">;

/** Why one call may not run, or null; a native subagent's call is checked against the stage's policy narrowed to its own. */
export function refusal(tool: GuardedCall["tool"], input: unknown, narrow?: Narrowing): string | null {
  const decision = checkCall({ tool, input }, { ...policy(), ...narrow });
  return decision.allow ? null : decision.reason;
}

/** The approval for one call: run it, or refuse it with the reason. */
export function approve(tool: GuardedCall["tool"], input: unknown, narrow?: Narrowing): ApprovalStatus {
  const reason = refusal(tool, input, narrow);
  return reason === null ? "not-applicable" : { type: "denied", reason };
}

/** eve's file tools name their target `filePath`; the guards read `path`. */
export const fileInput = (input: unknown): { path: unknown } => ({ path: (input as { filePath?: unknown } | undefined)?.filePath });

/** eve's glob and grep search a folder `path` (the workspace when absent) for a `pattern`. */
export const searchInput = (input: unknown): { path: unknown; pattern: unknown } => {
  const fields = (input ?? {}) as { path?: unknown; pattern?: unknown };
  return { path: fields.path ?? ".", pattern: fields.pattern };
};
