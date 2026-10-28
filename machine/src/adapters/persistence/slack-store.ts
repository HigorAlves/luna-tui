// Postgres implementation of the SlackStore port: the slack_items, slack_watches and
// slack_triage_runs tables.
// Timestamps are timestamptz in the database and ISO strings in the rows the inbox handles;
// this file does the conversion and nothing else.
import type { SlackItem, SlackPriority, SlackTriage, SlackTriageRun, SlackWatch, SlackWatchInput, SlackWatchPatch } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { IsNull, MoreThanOrEqual } from "typeorm";

import type { SlackMetricRow, SlackStore, SlackTriageRunInput } from "../../application/slack-store.ts";
import type { SlackItemRow } from "../../domain/slack-item.ts";
import { SlackItemEntity, SlackTriageRunEntity, SlackWatchEntity } from "./schemas.ts";

/** The slack_items row as TypeORM reads it. */
export interface SlackItemEntityRow {
  id: string;
  kind: SlackItem["kind"];
  channel: SlackItem["channel"];
  author: SlackItem["author"];
  text: string;
  threadTs: string | null;
  context: SlackItem["context"];
  permalink: string;
  ts: Date;
  slackTs: string;
  matched: string[];
  count: number;
  replies: number;
  youReplied: boolean;
  seenAt: Date | null;
  doneAt: Date | null;
  snoozedUntil: Date | null;
  reopenedAt: Date | null;
  repliedAt: Date | null;
  arrivedAt: Date;
  triage: SlackTriage | null;
  linked: SlackItem["linked"];
  createdAt: Date;
  updatedAt: Date;
}

export interface SlackWatchEntityRow {
  id: string;
  kind: SlackWatch["kind"];
  value: string;
  label: string;
  channels: string[];
  enabled: boolean;
  builtin: boolean;
  priority: SlackPriority | null;
  createdAt: Date;
}

export interface SlackTriageRunEntityRow {
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

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const date = (s: string | null): Date | null => (s ? new Date(s) : null);

function toRow(e: SlackItemEntityRow): SlackItemRow {
  return {
    id: e.id,
    kind: e.kind,
    channel: e.channel,
    author: e.author,
    text: e.text,
    threadTs: e.threadTs,
    context: e.context,
    permalink: e.permalink,
    ts: e.ts.toISOString(),
    slackTs: e.slackTs,
    matched: e.matched,
    count: e.count,
    replies: e.replies,
    youReplied: e.youReplied,
    seenAt: iso(e.seenAt),
    doneAt: iso(e.doneAt),
    snoozedUntil: iso(e.snoozedUntil),
    reopenedAt: iso(e.reopenedAt),
    repliedAt: iso(e.repliedAt),
    arrivedAt: e.arrivedAt.toISOString(),
    triage: e.triage,
    linked: e.linked,
  };
}

function toEntity(r: SlackItemRow): Omit<SlackItemEntityRow, "createdAt" | "updatedAt"> {
  return {
    ...r,
    ts: new Date(r.ts),
    seenAt: date(r.seenAt),
    doneAt: date(r.doneAt),
    snoozedUntil: date(r.snoozedUntil),
    reopenedAt: date(r.reopenedAt),
    repliedAt: date(r.repliedAt),
    arrivedAt: new Date(r.arrivedAt),
  };
}

const toWatch = (w: SlackWatchEntityRow): SlackWatch => ({ ...w, createdAt: w.createdAt.toISOString() });

const toRun = (r: SlackTriageRunEntityRow): SlackTriageRun => ({
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

export class PgSlackStore implements SlackStore {
  constructor(private readonly db: DataSource) {}

  async items(doneSince: Date): Promise<SlackItemRow[]> {
    const rows = await this.db.getRepository(SlackItemEntity).find({
      where: [{ doneAt: IsNull() }, { doneAt: MoreThanOrEqual(doneSince) }],
      order: { ts: "DESC" },
    });
    return rows.map(toRow);
  }

  async item(id: string): Promise<SlackItemRow | null> {
    const row = await this.db.getRepository(SlackItemEntity).findOneBy({ id });
    return row ? toRow(row) : null;
  }

  async save(rows: SlackItemRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.getRepository(SlackItemEntity).save(rows.map(toEntity));
  }

  async latestTs(): Promise<string | null> {
    const [row]: { ts: string | null }[] = await this.db.query("select max(slack_ts::numeric)::text as ts from slack_items");
    return row?.ts ?? null;
  }

  async metricRows(since: Date): Promise<SlackMetricRow[]> {
    const rows: { ts: Date; arrived_at: Date; replied_at: Date | null; priority: string | null; expects: boolean | null }[] = await this.db.query(
      `select ts, arrived_at, replied_at, triage->>'priority' as priority, (triage->>'expectsReply')::boolean as expects
         from slack_items where arrived_at >= $1`,
      [since],
    );
    return rows.map((r) => ({
      ts: r.ts.toISOString(),
      arrivedAt: r.arrived_at.toISOString(),
      repliedAt: iso(r.replied_at),
      priority: (r.priority as SlackPriority | null) ?? null,
      expectsReply: r.expects ?? false,
    }));
  }

  async watches(): Promise<SlackWatch[]> {
    const rows = await this.db.getRepository(SlackWatchEntity).find({ order: { createdAt: "ASC" } });
    return rows.map(toWatch);
  }

  async addWatch(input: SlackWatchInput & { label: string; builtin?: boolean }): Promise<SlackWatch> {
    const saved = await this.db.getRepository(SlackWatchEntity).save({
      kind: input.kind,
      value: input.value,
      label: input.label,
      channels: input.channels,
      enabled: true,
      builtin: input.builtin ?? false,
      priority: input.priority,
    });
    return toWatch(saved);
  }

  async patchWatch(id: string, patch: SlackWatchPatch): Promise<SlackWatch | null> {
    const repo = this.db.getRepository(SlackWatchEntity);
    const found = await repo.findOneBy({ id });
    if (!found) return null;
    const next = {
      ...found,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.channels !== undefined ? { channels: patch.channels } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    await repo.save(next);
    return toWatch(next);
  }

  async deleteWatch(id: string): Promise<void> {
    await this.db.getRepository(SlackWatchEntity).delete({ id });
  }

  async recordTriageRun(run: SlackTriageRunInput): Promise<SlackTriageRun> {
    const saved = await this.db.getRepository(SlackTriageRunEntity).save({
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

  async triageRuns(since: Date): Promise<SlackTriageRun[]> {
    const rows = await this.db.getRepository(SlackTriageRunEntity).find({ where: { startedAt: MoreThanOrEqual(since) }, order: { startedAt: "DESC" } });
    return rows.map(toRun);
  }
}
