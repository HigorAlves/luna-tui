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
      if (stage !== "triage") return queued ?? { outcome: "pass" };
      // A passing triage always carries an outcome and a record; a queued result's detail wins key by key.
      if (queued && queued.outcome !== "pass") return queued;
      return { ...queued, outcome: "pass", detail: { ...TRIAGE_DETAIL, criteria: context?.task?.criteria ?? [], ...queued?.detail } };
    };
  };
}
