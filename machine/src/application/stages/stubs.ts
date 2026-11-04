// Stub stages: used when MACHINE_AGENTS=off / no credential, and the /dev/stubs test seam
// the golden scripts drive. They pass unless told otherwise, so the whole pipeline can run
// end to end, and failure paths can be tested on demand.
import type { TaskState } from "@hardness/contracts";

import type { StageResult, StageRunner } from "../ports.ts";

/** What a passing triage stub says: a record draft, the plan outcome and the ticket's criteria. */
const TRIAGE_DETAIL = {
  outcome: "plan",
  record: { kind: "feature", goal: "Do what the ticket asks", size: "small", urgency: "normal", risk: "low", reason: "stub triage" },
};

/** What a passing plan stage stub says: a plan with no slices, a low risk, and every check skipped. */
const planDetail = (criteria: string[]) => ({
  brief: "stub plan",
  criteria,
  assumptions: [],
  slices: [],
  rollback: "revert the commit",
  cases: [],
  risk: { level: "low", scores: {} },
  verdicts: { coverage: "skipped", plan: "skipped", risk: "skipped" },
  rounds: { tests: 1, plan: 1 },
  flagged: [],
});

export class StubStages {
  private readonly planned = new Map<TaskState, StageResult[]>();

  /** Queues results for a stage. Once they are used up, the stage passes again. */
  plan(stage: TaskState, ...results: StageResult[]): void {
    this.planned.set(stage, [...(this.planned.get(stage) ?? []), ...results]);
  }

  /** Drops every queued result. */
  reset(): void {
    this.planned.clear();
  }

  readonly runnerFor = (stage: TaskState): StageRunner => {
    return async (context) => {
      const queued = this.planned.get(stage)?.shift();
      if (stage !== "triage" && stage !== "test_design") return queued ?? { outcome: "pass" };
      // A passing triage carries an outcome and a record, and a passing plan stage the plan the one approval shows;
      // a queued result's detail wins key by key.
      if (queued && queued.outcome !== "pass") return queued;
      const criteria = context?.task?.criteria ?? [];
      const detail = stage === "triage" ? { ...TRIAGE_DETAIL, criteria } : planDetail(criteria);
      return { ...queued, outcome: "pass", detail: { ...detail, ...queued?.detail } };
    };
  };
}
