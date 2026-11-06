// The `slack_drafts` table behind `ConversationDrafts`. A change happens in a transaction that first takes an advisory lock on the thread, so two
// taps in flight settle one row, and the unique index on waiting drafts holds the one-per-thread rule even if the lock were missed.
import type { DataSource, EntityManager } from "typeorm";

import type { DraftRow, DraftStore, DraftTx } from "../../application/conversation-drafts.ts";

type Raw = Record<string, unknown>;
const rowOf = (r: Raw): DraftRow => ({
  id: r.id as string, thread: r.thread as string, channel: r.channel as string, threadTs: r.thread_ts as string, kind: r.kind as DraftRow["kind"], status: r.status as DraftRow["status"],
  text: r.text as string, original: (r.original as string | null) ?? null, cardId: (r.card_id as string | null) ?? null, private: r.private as boolean,
  createdAt: new Date(r.created_at as string), expiresAt: new Date(r.expires_at as string), decidedAt: r.decided_at ? new Date(r.decided_at as string) : null,
  history: (r.history as DraftRow["history"]) ?? [], records: (r.records as Record<string, string>) ?? {},
});
const COLUMN: Record<string, string> = { status: "status", text: "text", original: "original", decidedAt: "decided_at", history: "history", records: "records", expiresAt: "expires_at" };

export class PgDraftStore implements DraftStore {
  constructor(private readonly db: DataSource) {}

  async transaction<T>(thread: string, fn: (tx: DraftTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (m: EntityManager) => {
      await m.query("select pg_advisory_xact_lock(hashtext($1))", [thread]);
      return fn({
        waiting: async (t) => {
          const [r] = await m.query("select * from slack_drafts where thread = $1 and status = 'waiting' for update", [t]);
          return r ? rowOf(r) : null;
        },
        insert: async (d) => {
          await m.query(
            `insert into slack_drafts (id, thread, channel, thread_ts, kind, status, text, original, card_id, private, created_at, expires_at, decided_at, history, records) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [d.id, d.thread, d.channel, d.threadTs, d.kind, d.status, d.text, d.original, d.cardId, d.private, d.createdAt, d.expiresAt, d.decidedAt, JSON.stringify(d.history), JSON.stringify(d.records)],
          );
        },
        update: async (id, patch) => {
          const entries = Object.entries(patch).filter(([k]) => k in COLUMN);
          if (entries.length === 0) return;
          const sets = entries.map(([k], i) => `${COLUMN[k]} = $${i + 2}`).join(", ");
          await m.query(`update slack_drafts set ${sets} where id = $1`, [id, ...entries.map(([k, v]) => (k === "history" || k === "records" ? JSON.stringify(v) : v))]);
        },
      });
    });
  }

  async get(id: string): Promise<DraftRow | null> {
    const [r] = await this.db.query("select * from slack_drafts where id = $1", [id]);
    return r ? rowOf(r) : null;
  }

  async allWaiting(): Promise<DraftRow[]> {
    return (await this.db.query("select * from slack_drafts where status = 'waiting'")).map(rowOf);
  }

  async posting(thread: string): Promise<DraftRow | null> {
    const [r] = await this.db.query("select * from slack_drafts where thread = $1 and status = 'posting'", [thread]);
    return r ? rowOf(r) : null;
  }

  async waitingExpiredBy(now: Date): Promise<DraftRow[]> {
    return (await this.db.query("select * from slack_drafts where status = 'waiting' and expires_at <= $1", [now])).map(rowOf);
  }

  async recentEdited(channel: string, isPrivate: boolean, n: number): Promise<DraftRow[]> {
    return (await this.db.query("select * from slack_drafts where status = 'edited' and channel = $1 and private = $2 order by decided_at desc, created_at desc limit $3", [channel, isPrivate, n])).map(rowOf);
  }
}
