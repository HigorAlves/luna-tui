// The evidence a plan found wrong in Build, Verify or review goes back to the planner with. The reviewer's thread and a failing run's
// output are other people's and a model's text: data, never instruction. The thread goes through `postable()` (capped at 1,500), the
// output's tail through `safe()` (capped at 2,000), the reason and the findings flattened and capped.
import type { PlanContext } from "@hardness/contracts";

import { safe } from "./evidence-markdown.ts";
import { postable } from "./postable.ts";

export const REPLAN_THREAD_CAP = 1500;
export const REPLAN_OUTPUT_CAP = 2000;
const REASON_CAP = 500;
const FINDING_CAP = 200;
const MAX_FINDINGS = 10;

type Replan = NonNullable<PlanContext["replan"]>;

/** What the raising stage's last `stage.finished` row says: its detail (`error`, `output` or `summary`, and the thread for a review) and its findings. */
export interface FinishedFacts {
  detail?: Record<string, unknown> | null;
  findings?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

export function replanOf(input: { raisedBy: string; reason: string; finished: FinishedFacts | null }): Replan {
  const detail = input.finished?.detail ?? {};
  const raw = text(detail.output) ?? text(detail.error) ?? text(detail.summary);
  const thread = text(detail.thread);
  const findings = (Array.isArray(input.finished?.findings) ? input.finished!.findings : Array.isArray(detail.findings) ? detail.findings : [])
    .flatMap((f) => {
      const row = f as { title?: unknown; path?: unknown; line?: unknown };
      const title = text(row.title);
      if (!title) return [];
      const where = typeof row.path === "string" ? `${row.path}${typeof row.line === "number" && row.line > 0 ? `:${row.line}` : ""} ` : "";
      return [safe(`${where}${title}`).slice(0, FINDING_CAP)];
    })
    .slice(0, MAX_FINDINGS);
  return {
    raised_by: input.raisedBy,
    reason: safe(input.reason).slice(0, REASON_CAP),
    ...(raw ? { output: safe(raw.slice(-REPLAN_OUTPUT_CAP)).slice(-REPLAN_OUTPUT_CAP) } : {}),
    ...(findings.length ? { findings } : {}),
    ...(thread ? { thread: postable(thread, REPLAN_THREAD_CAP) } : {}),
  };
}
