// Postgres implementation of the DatadogStore port: the datadog_items and datadog_triage_runs
// tables. An item is stored whole as `row` jsonb; `last_seen` and `done_at` are copied out as
// columns for the filters. Timestamps in columns are timestamptz, in rows ISO strings.
import type { DatadogItem, DatadogTriageRun } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { IsNull, LessThan, MoreThanOrEqual } from "typeorm";

import type { DatadogStore, DatadogTriageRunInput } from "../../application/datadog-store.ts";
import { DatadogItemEntity, DatadogTriageRunEntity } from "./schemas.ts";

/** The datadog_items row as TypeORM reads it. */
export interface DatadogItemEntityRow {
  id: string;
  row: DatadogItem;
  lastSeen: Date;
  doneAt: Date | null;
  updatedAt: Date;
}

export interface DatadogTriageRunEntityRow {
  id: string;
  startedAt: Date;
  endedAt: Date;
  items: number;
  model: string;
  turns: number;
  /** numeric comes back from pg as a string. */
  costUsd: string | number | null;
  ok: boolean;
  error: string | null;
}

const toEntity = (i: DatadogItem): Omit<DatadogItemEntityRow, "updatedAt"> => ({
  id: i.id,
  row: i,
  lastSeen: new Date(i.lastSeen),
  doneAt: i.doneAt ? new Date(i.doneAt) : null,
});

const toRun = (r: DatadogTriageRunEntityRow): DatadogTriageRun => ({
  id: r.id,
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt.toISOString(),
  items: r.items,
  model: r.model,
  turns: r.turns,
  costUsd: r.costUsd === null ? null : Number(r.costUsd),
  ok: r.ok,
  error: r.error,
});

export class PgDatadogStore implements DatadogStore {
  constructor(private readonly db: DataSource) {}

  async items(doneSince: Date): Promise<DatadogItem[]> {
    const rows = await this.db.getRepository(DatadogItemEntity).find({
      where: [{ doneAt: IsNull() }, { doneAt: MoreThanOrEqual(doneSince) }],
      order: { lastSeen: "DESC" },
    });
    return rows.map((r) => r.row);
  }

  async item(id: string): Promise<DatadogItem | null> {
    const row = await this.db.getRepository(DatadogItemEntity).findOneBy({ id });
    return row ? row.row : null;
  }

  async save(items: DatadogItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.getRepository(DatadogItemEntity).save(items.map(toEntity));
  }

  async prune(doneBefore: Date, runsBefore: Date | null): Promise<{ items: number; runs: number }> {
    const items = await this.db.getRepository(DatadogItemEntity).delete({ doneAt: LessThan(doneBefore) });
    const runs = runsBefore ? await this.db.getRepository(DatadogTriageRunEntity).delete({ startedAt: LessThan(runsBefore) }) : null;
    return { items: items.affected ?? 0, runs: runs?.affected ?? 0 };
  }

  async recordTriageRun(run: DatadogTriageRunInput): Promise<DatadogTriageRun> {
    const saved = await this.db.getRepository(DatadogTriageRunEntity).save({
      startedAt: new Date(run.startedAt),
      endedAt: new Date(run.endedAt),
      items: run.items,
      model: run.model,
      turns: run.turns,
      costUsd: run.costUsd,
      ok: run.ok,
      error: run.error,
    });
    return toRun(saved);
  }

  async triageRuns(since: Date): Promise<DatadogTriageRun[]> {
    const rows = await this.db.getRepository(DatadogTriageRunEntity).find({ where: { startedAt: MoreThanOrEqual(since) }, order: { startedAt: "DESC" } });
    return rows.map(toRun);
  }
}
