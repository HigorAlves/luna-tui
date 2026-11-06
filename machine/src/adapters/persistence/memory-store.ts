// The memory_items table (RFC 0007), by plain SQL like the tickets table. Rows are `MemoryItem`s; the bookkeeping the contract does not
// carry (a status note, a delete still to do, whether Cognee built a graph for it) lives in extra columns.
import type { MemoryAnchors, MemoryItem, MemoryStatus } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { MemoryListFilter } from "../../application/memory.ts";
import type { MemoryStore } from "../../application/memory-store.ts";

interface Raw {
  id: string;
  kind: MemoryItem["kind"];
  repo: string | null;
  source_kind: MemoryItem["source"]["kind"];
  source_ref: string | null;
  dataset_name: string;
  dataset_id: string | null;
  cognee_data_id: string | null;
  anchors: MemoryAnchors;
  provenance: MemoryItem["provenance"];
  trust: MemoryItem["trust"];
  status: MemoryStatus;
  text: string;
  content_hash: string;
  created_at: Date;
}

const COLUMNS = "id, kind, repo, source_kind, source_ref, dataset_name, dataset_id, cognee_data_id, anchors, provenance, trust, status, text, content_hash, created_at";
const LIVE = "('pending','active','stale')";
const MAX_LIST = 500;

const itemOf = (r: Raw): MemoryItem => ({
  id: r.id,
  kind: r.kind,
  repo: r.repo,
  source: { kind: r.source_kind, ref: r.source_ref },
  dataset: { name: r.dataset_name, id: r.dataset_id },
  cogneeDataId: r.cognee_data_id,
  anchors: r.anchors,
  provenance: r.provenance,
  trust: r.trust,
  status: r.status,
  text: r.text,
  contentHash: r.content_hash,
  createdAt: r.created_at.toISOString(),
});

export class PgMemoryStore implements MemoryStore {
  constructor(private readonly db: DataSource) {}

  private async rows(sql: string, params: unknown[] = []): Promise<MemoryItem[]> {
    return ((await this.db.query(sql, params)) as Raw[]).map(itemOf);
  }

  async insert(item: MemoryItem): Promise<void> {
    await this.db.query(
      `insert into memory_items (id, kind, repo, source_kind, source_ref, dataset_name, dataset_id, cognee_data_id, anchors, provenance, trust, status, text, content_hash, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [item.id, item.kind, item.repo, item.source.kind, item.source.ref, item.dataset.name, item.dataset.id, item.cogneeDataId, JSON.stringify(item.anchors), JSON.stringify(item.provenance), item.trust, item.status, item.text, item.contentHash, item.createdAt],
    );
  }

  async remove(id: string): Promise<void> {
    await this.db.query(`delete from memory_items where id = $1`, [id]);
  }

  async get(id: string): Promise<MemoryItem | null> {
    return (await this.rows(`select ${COLUMNS} from memory_items where id = $1`, [id]))[0] ?? null;
  }

  async getMany(ids: readonly string[]): Promise<MemoryItem[]> {
    if (ids.length === 0) return [];
    return this.rows(`select ${COLUMNS} from memory_items where id = any($1::text[])`, [[...ids]]);
  }

  async list(filter: MemoryListFilter): Promise<MemoryItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.repo === null) where.push("repo is null");
    else if (filter.repo !== undefined) add("repo = ?", filter.repo);
    if (filter.status) add("status = any(?::text[])", filter.status);
    if (filter.trust) add("trust = any(?::text[])", filter.trust);
    if (filter.kinds) add("kind = any(?::text[])", filter.kinds);
    if (filter.card) add("provenance->>'card' = ?", filter.card);
    params.push(Math.min(filter.limit ?? MAX_LIST, MAX_LIST), filter.offset ?? 0);
    return this.rows(`select ${COLUMNS} from memory_items ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc, id desc limit $${params.length - 1} offset $${params.length}`, params);
  }

  async findLive(dataset: string, contentHash: string): Promise<MemoryItem | null> {
    return (await this.rows(`select ${COLUMNS} from memory_items where dataset_name = $1 and content_hash = $2 and status in ${LIVE} order by created_at limit 1`, [dataset, contentHash]))[0] ?? null;
  }

  async liveDocs(repo: string | null, path: string): Promise<MemoryItem[]> {
    return this.rows(`select ${COLUMNS} from memory_items where kind = 'doc' and repo is not distinct from $1 and source_ref = $2 and status <> 'retired' and trust <> 'outside' order by created_at`, [repo, path]);
  }

  async liveCode(repo: string): Promise<MemoryItem[]> {
    return this.rows(`select ${COLUMNS} from memory_items where kind = 'code' and repo = $1 and status <> 'retired' order by created_at`, [repo]);
  }

  async byDataId(dataId: string): Promise<MemoryItem | null> {
    return (await this.rows(`select ${COLUMNS} from memory_items where cognee_data_id = $1 limit 1`, [dataId]))[0] ?? null;
  }

  async pending(limit: number): Promise<MemoryItem[]> {
    return this.rows(`select ${COLUMNS} from memory_items where status = 'pending' order by created_at, id limit $1`, [limit]);
  }

  async pendingForgets(limit: number): Promise<MemoryItem[]> {
    return this.rows(`select ${COLUMNS} from memory_items where forget_pending and cognee_data_id is not null order by updated_at limit $1`, [limit]);
  }

  async markAdded(id: string, added: { dataId: string; datasetId: string }): Promise<void> {
    await this.db.query(`update memory_items set status = 'active', cognee_data_id = $2, dataset_id = $3, updated_at = now() where id = $1 and status = 'pending'`, [id, added.dataId, added.datasetId]);
  }

  async setStatus(id: string, status: MemoryStatus, note: string | null, forgetPending = false): Promise<void> {
    await this.db.query(`update memory_items set status = $2, status_note = $3, forget_pending = $4, updated_at = now() where id = $1`, [id, status, note, forgetPending]);
  }

  async adopt(id: string, by: string): Promise<boolean> {
    const [row] = (await this.db.query(
      `with u as (update memory_items set trust = 'lesson', provenance = provenance || $2::jsonb, status_note = $3, updated_at = now() where id = $1 and trust = 'outside' returning id) select count(*)::int as n from u`,
      [id, JSON.stringify({ by: "person" }), `adopted by ${by}`],
    )) as Array<{ n: number }>;
    return (row?.n ?? 0) > 0;
  }

  async withData(datasets?: readonly string[]): Promise<MemoryItem[]> {
    if (datasets) return this.rows(`select ${COLUMNS} from memory_items where cognee_data_id is not null and status <> 'retired' and dataset_name = any($1::text[])`, [[...datasets]]);
    return this.rows(`select ${COLUMNS} from memory_items where cognee_data_id is not null and status <> 'retired'`);
  }

  async uncognified(datasets: readonly string[]): Promise<number> {
    const [row] = (await this.db.query(`select count(*)::int as n from memory_items where dataset_name = any($1::text[]) and status in ('active','stale') and cognee_data_id is not null and cognified_at is null`, [[...datasets]])) as Array<{ n: number }>;
    return row?.n ?? 0;
  }

  async markCognified(datasets: readonly string[]): Promise<void> {
    await this.db.query(`update memory_items set cognified_at = now() where dataset_name = any($1::text[]) and status in ('active','stale') and cognee_data_id is not null and cognified_at is null`, [[...datasets]]);
  }

  async cognifiedOn(day: string): Promise<number> {
    const [row] = (await this.db.query(`select items from memory_cognify_days where day = $1`, [day])) as Array<{ items: number }>;
    return row?.items ?? 0;
  }

  async addCognified(day: string, items: number): Promise<void> {
    await this.db.query(`insert into memory_cognify_days (day, items) values ($1, $2) on conflict (day) do update set items = memory_cognify_days.items + excluded.items`, [day, items]);
  }

  async counts(): Promise<{ pending: number; active: number }> {
    const [row] = (await this.db.query(`select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status in ('active','stale'))::int as active from memory_items`)) as Array<{ pending: number; active: number }>;
    return { pending: row?.pending ?? 0, active: row?.active ?? 0 };
  }
}
