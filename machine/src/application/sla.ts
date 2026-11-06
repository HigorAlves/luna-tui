// The ticket clocks for the API: each task's SLA computed from the row (when it entered its
// state), the running stage run's start and its repo's targets, at the moment it is serialized.
// Nothing is stored beyond `state_since`; a minute tick (main.ts) recomputes every open task
// from one list and one stage-run query, and republishes the tasks whose clocks flipped.
import { FACTORY_DEFAULTS, RUN_OR_GATE, TaskSla, isTerminal } from "@hardness/contracts";

import { type SlaDefaults, type SlaTargets, computeSla, slaFlags } from "../domain/sla.ts";
import { AUTO_ARCHIVE_GATES } from "./sla-actions.ts";
import type { TaskRow } from "../domain/task.ts";
import type { Policy } from "../domain/policy.ts";

export interface SlaClocksOptions {
  pipeline: {
    /** When each task's running stage run started, for the tasks that have one. */
    runningStageStarts(): Promise<Map<string, Date>>;
    approvals(id: string): Promise<Array<{ decision: string | null }>>;
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
    const [sla] = await this.compute([task]);
    return sla ?? null;
  }

  /** Every task's clocks, from one stage-run query and one policy read per repo. */
  async forAll(tasks: TaskRow[]): Promise<Map<string, TaskSla | null>> {
    const clocks = await this.compute(tasks);
    return new Map(tasks.map((task, i) => [task.id, clocks[i] ?? null]));
  }

  /** The open tasks whose overdue or warn flags changed since they were last shown. */
  async flipped(tasks: TaskRow[]): Promise<Array<{ task: TaskRow; sla: TaskSla | null }>> {
    const open = tasks.filter((task) => !isTerminal(task.state));
    for (const task of tasks) if (isTerminal(task.state)) this.shown.delete(task.id);
    const before = new Map([...this.shown]);
    const clocks = await this.forAll(open);
    return open.filter((task) => before.has(task.id) && before.get(task.id) !== slaFlags(clocks.get(task.id) ?? null)).map((task) => ({ task, sla: clocks.get(task.id) ?? null }));
  }

  private async compute(tasks: TaskRow[]): Promise<Array<TaskSla | null>> {
    const now = this.now();
    const policies = new Map<string | null, Promise<Policy>>();
    const policyOf = (repoPath: string | null) => {
      let found = policies.get(repoPath);
      if (!found) policies.set(repoPath, (found = this.options.pipeline.policyFor(repoPath)));
      return found;
    };
    // The stage runs are read once, and only when some task's state carries a stage target.
    let running: Promise<Map<string, Date>> | null = null;
    const startOf = (task: TaskRow) => (running ??= this.options.pipeline.runningStageStarts()).then((m) => m.get(task.id) ?? null);
    return Promise.all(
      tasks.map(async (task) => {
        try {
          const policy = await policyOf(task.repoPath);
          const stageStartedAt = policy.sla.stage?.[task.state] ? await startOf(task) : null;
          const gateOpen = RUN_OR_GATE.has(task.state) ? (await this.options.pipeline.approvals(task.id)).some((a) => a.decision === null) : undefined;
          const sla = computeSla({ task, stateSince: task.stateSince, stageStartedAt, targets: triageGateTargets(task.state, policy), defaults: this.options.defaults, ...(gateOpen === undefined ? {} : { gateOpen }) }, now);
          this.shown.set(task.id, slaFlags(sla));
          return sla;
        } catch (error) {
          console.warn(`sla: could not compute the clocks of task ${task.id}`, error);
          return null;
        }
      }),
    );
  }
}

/** The repo's targets, with the plan gate's reminder (`plan.sla.reminder_days`) and the triage gates' reminder (`triage.sla.reminder_days`) where the repo moved it off the diagram's two days and its `sla` block names no gate target. */
function triageGateTargets(state: string, policy: Policy): Partial<SlaTargets> {
  // The plan gate has its own days (`plan.sla.reminder_days`); the intake gates take triage's.
  // The ship approval has its own (`ship.sla.reminder_days`).
  const days = state === "awaiting_approval" ? policy.factory.plan.sla.reminder_days : state === "awaiting_ship" ? policy.factory.ship.sla.reminder_days : policy.factory.triage.sla.reminder_days;
  const standard = state === "awaiting_approval" ? FACTORY_DEFAULTS.plan.sla.reminder_days : state === "awaiting_ship" ? FACTORY_DEFAULTS.ship.sla.reminder_days : FACTORY_DEFAULTS.triage.sla.reminder_days;
  if (policy.sla.gate !== undefined || !(state === "awaiting_approval" || state === "awaiting_ship" || AUTO_ARCHIVE_GATES.has(state as never)) || days === standard) return policy.sla;
  return { ...policy.sla, gate: days * 86_400 };
}
