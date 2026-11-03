// The core guards (core/guards.ts) as eve tool approvals: a refused call never starts and the model
// reads the reason (the spike's finding; eve's hooks fire only after the fact). The policy is the
// stage's, passed by the runner in LUNA_EVE_GUARD; without one every guarded call is refused.
import type { ApprovalStatus } from "eve/tools/approval";

import { type GuardContext, type GuardedCall, checkCall } from "../../../core/guards.ts";

function policy(): GuardContext {
  try {
    return JSON.parse(process.env.LUNA_EVE_GUARD ?? "") as GuardContext;
  } catch {
    return { writable: false, commands: [], deniedRoots: ["/"] };
  }
}

/** Why one call may not run, or null. */
export function refusal(tool: GuardedCall["tool"], input: unknown): string | null {
  const decision = checkCall({ tool, input }, policy());
  return decision.allow ? null : decision.reason;
}

/** The approval for one call: run it, or refuse it with the reason. */
export function approve(tool: GuardedCall["tool"], input: unknown): ApprovalStatus {
  const reason = refusal(tool, input);
  return reason === null ? "not-applicable" : { type: "denied", reason };
}

/** eve's file tools name their target `filePath`; the guards read `path`. */
export const fileInput = (input: unknown): { path: unknown } => ({ path: (input as { filePath?: unknown } | undefined)?.filePath });
