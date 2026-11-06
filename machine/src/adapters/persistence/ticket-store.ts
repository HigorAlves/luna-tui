// Postgres implementation of the ticket store: the tickets table, by plain SQL. A read refreshes only `canonical`.
import type { CanonicalTicket } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { TicketRow, TicketStore } from "../../application/tickets.ts";

interface Raw {
  key: string;
  canonical: CanonicalTicket;
  assessments: TicketRow["assessments"];
  card_id: string | null;
  drafts: TicketRow["drafts"];
  clocks: TicketRow["clocks"];
  machine_status: string | null;
  machine_links: TicketRow["machineLinks"];
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = "key, canonical, assessments, card_id, drafts, clocks, machine_status, machine_links, created_at, updated_at";

const rowOf = (r: Raw): TicketRow => ({ key: r.key, canonical: r.canonical, assessments: r.assessments, cardId: r.card_id, drafts: r.drafts, clocks: r.clocks, machineStatus: r.machine_status, machineLinks: r.machine_links, createdAt: r.created_at, updatedAt: r.updated_at });

export class PgTicketStore implements TicketStore {
  constructor(private readonly db: DataSource) {}

  async read(ticket: CanonicalTicket): Promise<TicketRow> {
    const [row] = (await this.db.query(
      `insert into tickets (key, canonical) values ($1, $2)
       on conflict (key) do update set canonical = excluded.canonical, updated_at = now()
       returning ${COLUMNS}`,
      [ticket.key, JSON.stringify(ticket)],
    )) as Raw[];
    return rowOf(row!);
  }

  async get(key: string): Promise<TicketRow | null> {
    const [row] = (await this.db.query(`select ${COLUMNS} from tickets where key = $1`, [key])) as Raw[];
    return row ? rowOf(row) : null;
  }

  async list(): Promise<TicketRow[]> {
    return ((await this.db.query(`select ${COLUMNS} from tickets order by created_at, key`)) as Raw[]).map(rowOf);
  }

  async setMachine(key: string, change: { status?: string | null; links?: Array<{ kind: string; target: string }>; cardId?: string | null }): Promise<void> {
    await this.db.query(
      `update tickets set
         machine_status = case when $2::boolean then $3 else machine_status end,
         machine_links = case when $4::boolean then $5::jsonb else machine_links end,
         card_id = case when $6::boolean then $7 else card_id end,
         updated_at = now()
       where key = $1`,
      [key, change.status !== undefined, change.status ?? null, change.links !== undefined, JSON.stringify(change.links ?? []), change.cardId !== undefined, change.cardId ?? null],
    );
  }

  async appendAssessment(key: string, entry: Record<string, unknown>): Promise<void> {
    // The history keeps the last 20 entries, oldest first.
    await this.db.query(
      `update tickets set assessments = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (select e, n from jsonb_array_elements(assessments || $2::jsonb) with ordinality as t(e, n) order by n desc limit 20) s), updated_at = now() where key = $1`,
      [key, JSON.stringify([entry])],
    );
  }

  async setDrafts(key: string, drafts: Record<string, unknown>[]): Promise<void> {
    await this.db.query("update tickets set drafts = $2::jsonb, updated_at = now() where key = $1", [key, JSON.stringify(drafts)]);
  }

  /** Changes the drafts under a row lock: `change` sees the drafts as they are now and answers the drafts to keep (the same list to change nothing). */
  async updateDrafts(key: string, change: (drafts: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = (await tx.query("select drafts from tickets where key = $1 for update", [key])) as Array<{ drafts: Record<string, unknown>[] }>;
      if (!row) return;
      const next = change(row.drafts);
      if (next !== row.drafts) await tx.query("update tickets set drafts = $2::jsonb, updated_at = now() where key = $1", [key, JSON.stringify(next)]);
    });
  }

  async setClocks(key: string, clocks: Record<string, unknown>): Promise<void> {
    await this.db.query("update tickets set clocks = $2::jsonb, updated_at = now() where key = $1", [key, JSON.stringify(clocks)]);
  }
}
