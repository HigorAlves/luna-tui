// Postgres implementation of the backlog's store: the backlog_items table, by plain SQL.
import type { BacklogAddInput } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { BacklogRow, BacklogStore } from "../../application/backlog.ts";

interface Raw {
  id: string;
  title: string;
  text: string;
  sources: BacklogRow["sources"];
  repo: string | null;
  scores: BacklogRow["scores"];
  size: BacklogRow["size"];
  demand: number;
  depends_on: string[];
  added_at: Date;
  assessed_at: Date;
}

const COLUMNS = "id, title, text, sources, repo, scores, size, demand, depends_on, added_at, assessed_at";

const rowOf = (r: Raw): BacklogRow => ({ id: r.id, title: r.title, text: r.text, sources: r.sources, repo: r.repo, scores: r.scores, size: r.size, demand: r.demand, dependsOn: r.depends_on, addedAt: r.added_at, assessedAt: r.assessed_at });

export class PgBacklogStore implements BacklogStore {
  constructor(private readonly db: DataSource) {}

  async add(input: BacklogAddInput): Promise<BacklogRow> {
    const [row] = (await this.db.query(
      `insert into backlog_items (title, text, sources, repo, scores, size, depends_on) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
      [input.title, input.text, JSON.stringify(input.sources), input.repo, JSON.stringify(input.scores), input.size, JSON.stringify(input.dependsOn)],
    )) as Raw[];
    return rowOf(row!);
  }

  async list(): Promise<BacklogRow[]> {
    return ((await this.db.query(`select ${COLUMNS} from backlog_items order by added_at, id`)) as Raw[]).map(rowOf);
  }

  async get(id: string): Promise<BacklogRow | null> {
    const [row] = (await this.db.query(`select ${COLUMNS} from backlog_items where id = $1`, [id])) as Raw[];
    return row ? rowOf(row) : null;
  }

  async bump(id: string): Promise<BacklogRow | null> {
    // An UPDATE ... RETURNING answers [rows, affected] on this driver.
    const [rows] = (await this.db.query(`update backlog_items set demand = demand + 1, assessed_at = now() where id = $1 returning ${COLUMNS}`, [id])) as [Raw[], number];
    return rows[0] ? rowOf(rows[0]) : null;
  }

  async unbump(id: string): Promise<BacklogRow | null> {
    const [rows] = (await this.db.query(`update backlog_items set demand = greatest(1, demand - 1) where id = $1 returning ${COLUMNS}`, [id])) as [Raw[], number];
    return rows[0] ? rowOf(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const [, count] = (await this.db.query("delete from backlog_items where id = $1", [id])) as [unknown, number];
    return count > 0;
  }
}
