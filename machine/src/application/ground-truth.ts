// Ground truth for the plan stage: when a person approves the plan, what the machine proposed and
// what they approved (with every edit between) is kept as one file, so a later eval can learn from
// what a person changed. It lives under the machine's state dir, never in the repo the task works
// on: the machine runs for any repository and writes nothing of its own into one.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApprovalRow, TaskRow } from "../domain/task.ts";

const PLAN_KEYS = ["brief", "criteria", "assumptions", "slices", "rollback", "cases", "risk", "map"] as const;

type Plan = Partial<Record<(typeof PLAN_KEYS)[number], unknown>>;
type Revision = { at?: unknown; before?: Record<string, unknown>; after?: Record<string, unknown> };

const pick = (from: Record<string, unknown>): Plan => Object.fromEntries(PLAN_KEYS.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));

export interface GroundTruth {
  schema: 1;
  task: { id: string; title: string; description: string; criteria: string[] };
  record: unknown;
  /** The plan as the machine proposed it: the approved plan with every revision undone, latest first. */
  proposed: Plan;
  approved: Plan;
  revisions: unknown[];
  verdicts: unknown;
  risk: unknown;
  /** A person's override of the risk level or the code map, each with its reason; the risk override says whether it applied (a lower one is kept, not applied). */
  overrides: unknown;
  approvers: string[];
  decidedAt: string | null;
}

/** The record of one approved plan gate. Pure. */
export function groundTruthOf(task: TaskRow, approval: ApprovalRow): GroundTruth {
  const requested = approval.requested;
  const approved = pick(requested);
  const revisions = (Array.isArray(requested.revisions) ? requested.revisions : []) as Revision[];
  const proposed: Plan = { ...approved };
  for (const revision of [...revisions].reverse()) {
    for (const key of Object.keys(revision.after ?? {})) {
      if (revision.before && key in revision.before) (proposed as Record<string, unknown>)[key] = revision.before[key];
      else delete (proposed as Record<string, unknown>)[key];
    }
  }
  const response = approval.response ?? {};
  const named = Array.isArray(response.approvers) ? response.approvers.map(String) : typeof response.approver === "string" ? [response.approver] : [];
  return {
    schema: 1,
    task: { id: task.id, title: task.title, description: task.description, criteria: task.criteria },
    record: task.record ?? null,
    proposed,
    approved,
    revisions,
    verdicts: requested.verdicts ?? null,
    risk: requested.risk ?? null,
    overrides: requested.overrides ?? null,
    approvers: named,
    decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
  };
}

/** Writes `<stateDir>/ground-truth/plan/<taskId>-<approvalId>.json` and answers its path. */
export function groundTruthWriter(stateDir: string): (task: TaskRow, approval: ApprovalRow) => Promise<string> {
  return async (task, approval) => {
    const dir = join(stateDir, "ground-truth", "plan");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${task.id}-${approval.id}.json`);
    await writeFile(path, `${JSON.stringify(groundTruthOf(task, approval), null, 2)}\n`);
    return path;
  };
}
