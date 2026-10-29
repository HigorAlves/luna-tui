// The persistence port the Datadog inbox depends on: items with their triage and your done and
// snooze state (they must survive a restart) and one row per triage run. Postgres implements it
// in adapters/persistence/datadog-store.ts; the inbox's tests use InMemoryDatadogStore.
import type { DatadogItem, DatadogTriageRun } from "@hardness/contracts";

/** One datadog_triage run as recorded; the store assigns the id. */
export type DatadogTriageRunInput = Omit<DatadogTriageRun, "id">;

export interface DatadogStore {
  /** Every open item, plus the ones done at or after `doneSince`. */
  items(doneSince: Date): Promise<DatadogItem[]>;
  item(id: string): Promise<DatadogItem | null>;
  /** Inserts or replaces by id. */
  save(items: DatadogItem[]): Promise<void>;
  /** Deletes items done before `doneBefore` and, when given, triage runs started before `runsBefore`. */
  prune(doneBefore: Date, runsBefore: Date | null): Promise<{ items: number; runs: number }>;
  recordTriageRun(run: DatadogTriageRunInput): Promise<DatadogTriageRun>;
  /** Runs started at or after `since`, newest first. */
  triageRuns(since: Date): Promise<DatadogTriageRun[]>;
}

export class InMemoryDatadogStore implements DatadogStore {
  readonly rows = new Map<string, DatadogItem>();
  readonly runs: DatadogTriageRun[] = [];

  async items(doneSince: Date): Promise<DatadogItem[]> {
    return [...this.rows.values()].filter((i) => i.doneAt === null || new Date(i.doneAt) >= doneSince);
  }

  async item(id: string): Promise<DatadogItem | null> {
    return this.rows.get(id) ?? null;
  }

  async save(items: DatadogItem[]): Promise<void> {
    for (const i of items) this.rows.set(i.id, i);
  }

  async prune(doneBefore: Date, runsBefore: Date | null): Promise<{ items: number; runs: number }> {
    let items = 0;
    for (const [id, i] of this.rows) if (i.doneAt && new Date(i.doneAt) < doneBefore && this.rows.delete(id)) items++;
    const before = this.runs.length;
    if (runsBefore) this.runs.splice(0, this.runs.length, ...this.runs.filter((r) => new Date(r.startedAt) >= runsBefore));
    return { items, runs: before - this.runs.length };
  }

  async recordTriageRun(run: DatadogTriageRunInput): Promise<DatadogTriageRun> {
    const row = { ...run, id: String(this.runs.length + 1) };
    this.runs.push(row);
    return row;
  }

  async triageRuns(since: Date): Promise<DatadogTriageRun[]> {
    return this.runs.filter((r) => new Date(r.startedAt) >= since).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
