// Postgres implementation of the claim journal: the brain_claims table, by plain SQL. The unique index on (source, statement) makes
// the same source handing over the same statement twice one row.
import { randomUUID } from "node:crypto";

import { type BrainClaim, type ClaimStatus, shadowReady } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { ClaimPatch, ClaimStats, ClaimStore, NewClaim } from "../../application/brain-claims.ts";

type Raw = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 200;
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

const rowOf = (r: Raw): BrainClaim => ({
  id: r.id as string,
  repo: (r.repo as string | null) ?? null,
  repoPath: (r.repo_path as string | null) ?? null,
  taskId: (r.task_id as string | null) ?? null,
  statement: r.statement as string,
  quote: r.quote as string,
  kind: r.kind as BrainClaim["kind"],
  scope: r.scope as BrainClaim["scope"],
  source: { kind: r.source_kind as "card" | "note", ref: r.source_ref as string, title: r.source_title as string },
  speaker: (r.speaker as string | null) ?? null,
  speakerTrust: r.speaker_trust as BrainClaim["speakerTrust"],
  extractor: r.extractor as string,
  status: r.status as ClaimStatus,
  refusal: (r.refusal as string | null) ?? null,
  tier: (r.tier as BrainClaim["tier"]) ?? null,
  proposed: (r.proposed as BrainClaim["proposed"]) ?? null,
  reasons: (r.reasons as string[]) ?? [],
  durable: (r.durable as boolean | null) ?? null,
  contradicts: (r.contradicts as string[]) ?? [],
  recordId: (r.record_id as string | null) ?? null,
  decidedBy: (r.decided_by as BrainClaim["decidedBy"]) ?? null,
  decidedAt: r.decided_at ? iso(r.decided_at) : null,
  createdAt: iso(r.created_at),
});

const COLUMN: Record<keyof ClaimPatch, string> = {
  status: "status", tier: "tier", proposed: "proposed", durable: "durable", contradicts: "contradicts", recordId: "record_id", decidedBy: "decided_by", decidedAt: "decided_at", reasons: "reasons",
};

export class PgClaimStore implements ClaimStore {
  constructor(private readonly db: DataSource) {}

  async add(claim: NewClaim): Promise<BrainClaim | null> {
    const [row] = (await this.db.query(
      `insert into brain_claims (id, repo_path, repo, task_id, statement, quote, kind, scope, source_kind, source_ref, source_title, speaker, speaker_trust, extractor, status, refusal, reasons)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (source_kind, source_ref, statement) do nothing
       returning *`,
      [randomUUID(), claim.repoPath, claim.repo, claim.taskId, claim.statement, claim.quote, claim.kind, claim.scope, claim.source.kind, claim.source.ref, claim.source.title, claim.speaker, claim.speakerTrust, claim.extractor, claim.status, claim.refusal, JSON.stringify(claim.reasons)],
    )) as Raw[];
    return row ? rowOf(row) : null;
  }

  async get(id: string): Promise<BrainClaim | null> {
    if (!UUID.test(id)) return null;
    const [row] = (await this.db.query("select * from brain_claims where id = $1", [id])) as Raw[];
    return row ? rowOf(row) : null;
  }

  async findBySource(source: { kind: string; ref: string }, statement: string): Promise<BrainClaim | null> {
    const [row] = (await this.db.query("select * from brain_claims where source_kind = $1 and source_ref = $2 and statement = $3", [source.kind, source.ref, statement])) as Raw[];
    return row ? rowOf(row) : null;
  }

  async list(filter: { status?: ClaimStatus; except?: ClaimStatus; repoPath?: string; since?: Date; decidedBy?: "code" | "jev" | "person"; decidedSince?: Date; limit?: number; order?: "updated_asc" } = {}): Promise<BrainClaim[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => where.push(sql.replace("?", `$${params.push(value)}`));
    if (filter.status) add("status = ?", filter.status);
    if (filter.except) add("status <> ?", filter.except);
    if (filter.repoPath) add("repo_path = ?", filter.repoPath);
    if (filter.since) add("updated_at >= ?", filter.since);
    if (filter.decidedBy) add("decided_by = ?", filter.decidedBy);
    if (filter.decidedSince) add("decided_at >= ?", filter.decidedSince);
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? LIMIT_DEFAULT), 1), LIMIT_MAX);
    const rows = (await this.db.query(
      `select * from brain_claims ${where.length ? `where ${where.join(" and ")}` : ""} order by ${filter.order === "updated_asc" ? "updated_at asc, id asc" : "created_at desc, id desc"} limit ${limit}`,
      params,
    )) as Raw[];
    return rows.map(rowOf);
  }

  async update(id: string, patch: ClaimPatch, options: { ifStatus?: ClaimStatus } = {}): Promise<BrainClaim | null> {
    if (!UUID.test(id)) return null;
    const entries = (Object.entries(patch) as Array<[keyof ClaimPatch, unknown]>).filter(([k, v]) => k in COLUMN && v !== undefined);
    const params: unknown[] = [id];
    const sets = entries.map(([k, v]) => `${COLUMN[k]} = $${params.push(k === "reasons" || k === "contradicts" ? JSON.stringify(v) : v)}`);
    sets.push("updated_at = greatest(now(), updated_at + interval '1 millisecond')");
    // TypeORM answers an UPDATE ... RETURNING as [rows, count] on Postgres.
    const guard = options.ifStatus ? ` and status = $${params.push(options.ifStatus)}` : "";
    const [rows] = (await this.db.query(`update brain_claims set ${sets.join(", ")} where id = $1${guard} returning *`, params)) as [Raw[], number];
    return rows[0] ? rowOf(rows[0]) : null;
  }

  async stats(repoPath?: string): Promise<ClaimStats> {
    const [r] = (await this.db.query(
      `select
         count(*) filter (where status = 'unverified')::int as waiting,
         count(*) filter (where decided_by = 'person' and proposed in ('verify','flag','reject'))::int as decided,
         count(*) filter (where decided_by = 'person' and ((status = 'verified' and proposed in ('verify','flag')) or (status = 'rejected' and proposed = 'reject')))::int as agreed,
         count(*) filter (where decided_by = 'person' and status = 'rejected' and proposed in ('verify','flag'))::int as missed
       from brain_claims where ($1::text is null or repo_path = $1)`,
      [repoPath ?? null],
    )) as Array<{ waiting: number; decided: number; agreed: number; missed: number }>;
    const { waiting, decided, agreed, missed } = r!;
    return { waiting, decided, agreed, missed, ready: shadowReady({ decided, agreed, missed }) };
  }
}
