// Stub stages: used when MACHINE_AGENTS=off / no credential, and the /dev/stubs test seam
// the golden scripts drive. They pass unless told otherwise, so the whole pipeline can run
// end to end, and failure paths can be tested on demand.
import type { TaskState } from "@hardness/contracts";

import type { StageResult, StageRunner } from "./runner.ts";

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
    return async () => this.planned.get(stage)?.shift() ?? { outcome: "pass" };
  };
}
