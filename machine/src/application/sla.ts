// The ticket clocks for the API: each task's SLA computed from its history (when it started
// waiting, when its stage started) and its repo's targets, at the moment it is serialized.
// Nothing is stored; a minute tick (main.ts) republishes the tasks whose clocks flipped.
import type { TaskSla } from "@hardness/contracts";

import { type SlaDefaults, computeSla, slaFlags } from "../domain/sla.ts";
import type { EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import type { Policy } from "../domain/policy.ts";

export interface SlaClocksOptions {
  pipeline: {
    events(id: string): Promise<EventRow[]>;
    stageRuns(id: string): Promise<StageRunRow[]>;
    policyFor(repoPath: string | null): Promise<Policy>;
  };
  /** The machine's env defaults (`MACHINE_SLA_GATE`, `MACHINE_SLA_CYCLE`). */
  defaults: SlaDefaults;
  now?: () => Date;
}

export class SlaClocks {
  private readonly now: () => Date;
  /** The flags each task last showed, so the tick publishes only a flip. */
  private readonly shown = new Map<string, string>();

  constructor(private readonly options: SlaClocksOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The task's clocks right now; null when none applies. Never throws: a failed lookup shows no clock. */
  async for(task: TaskRow): Promise<TaskSla | null> {
    try {
      const policy = await this.options.pipeline.policyFor(task.repoPath);
      const needsSince = task.state !== "closed" && task.state !== "draft";
      const [events, runs] = await Promise.all([
        needsSince ? this.options.pipeline.events(task.id) : Promise.resolve([]),
        policy.sla.stage?.[task.state] ? this.options.pipeline.stageRuns(task.id) : Promise.resolve([]),
      ]);
      const entered = events.findLast((e) => e.kind === "transition" && e.payload.to === task.state);
      const running = runs.findLast((r) => r.stage === task.state && r.status === "running");
      const sla = computeSla(
        { task, stateSince: entered?.at ?? null, stageStartedAt: running?.startedAt ?? null, targets: policy.sla, defaults: this.options.defaults },
        this.now(),
      );
      this.shown.set(task.id, slaFlags(sla));
      return sla;
    } catch (error) {
      console.warn(`sla: could not compute the clocks of task ${task.id}`, error);
      return null;
    }
  }

  /** The open tasks whose overdue or warn flags changed since they were last shown; each is recomputed. */
  async flipped(tasks: TaskRow[]): Promise<Array<{ task: TaskRow; sla: TaskSla | null }>> {
    const out: Array<{ task: TaskRow; sla: TaskSla | null }> = [];
    for (const task of tasks) {
      if (task.state === "closed") {
        this.shown.delete(task.id);
        continue;
      }
      const before = this.shown.get(task.id);
      const sla = await this.for(task);
      if (before !== undefined && before !== slaFlags(sla)) out.push({ task, sla });
    }
    return out;
  }
}
