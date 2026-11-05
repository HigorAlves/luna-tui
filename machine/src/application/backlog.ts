// The shared backlog: candidates that are not cards yet. Stored, ranked by script (domain/backlog.ts), and either promoted into a card
// (through `create_card`, with their scores as hints) or declined. A duplicate found by intake bumps an item where it would have merged a card.
import { type BacklogAddInput, type BacklogEntry, type BacklogScores, type BacklogSize, type CardSource, FACTORY_DEFAULTS, type TaskSource } from "@hardness/contracts";

import { rankBacklog } from "../domain/backlog.ts";
import type { NewTask } from "./pipeline.ts";
import type { TaskRow } from "../domain/task.ts";

export interface BacklogRow {
  id: string;
  title: string;
  text: string;
  sources: (TaskSource | CardSource)[];
  repo: string | null;
  scores: BacklogScores;
  size: BacklogSize;
  demand: number;
  dependsOn: string[];
  addedAt: Date;
  assessedAt: Date;
}

export interface BacklogStore {
  add(input: BacklogAddInput): Promise<BacklogRow>;
  list(): Promise<BacklogRow[]>;
  get(id: string): Promise<BacklogRow | null>;
  /** Demand plus one, and the item counts as assessed now. */
  bump(id: string): Promise<BacklogRow | null>;
  remove(id: string): Promise<boolean>;
}

export class BacklogItemNotFoundError extends Error {
  constructor(id: string) {
    super(`backlog item ${id} not found`);
    this.name = "BacklogItemNotFoundError";
  }
}

export interface BacklogOptions {
  store: BacklogStore;
  pipeline: { createTask(input: NewTask): Promise<TaskRow> };
  /** `backlog.stale_days`. */
  staleDays?: number;
  now?: () => Date;
}

export class Backlog {
  private readonly staleDays: number;
  private readonly now: () => Date;

  constructor(private readonly options: BacklogOptions) {
    this.staleDays = options.staleDays ?? FACTORY_DEFAULTS.backlog.stale_days;
    this.now = options.now ?? (() => new Date());
  }

  private entries(rows: BacklogRow[]): BacklogEntry[] {
    const ranked = rankBacklog(rows, { now: this.now(), staleDays: this.staleDays });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ranked.map((r) => {
      const row = byId.get(r.id)!;
      return { id: row.id, title: row.title, text: row.text, sources: row.sources, repo: row.repo, scores: row.scores, size: row.size, demand: row.demand, dependsOn: row.dependsOn, addedAt: row.addedAt.toISOString(), assessedAt: row.assessedAt.toISOString(), score: r.score, stale: r.stale };
    });
  }

  private async entry(row: BacklogRow): Promise<BacklogEntry> {
    return this.entries([row])[0]!;
  }

  async list(): Promise<BacklogEntry[]> {
    return this.entries(await this.options.store.list());
  }

  async add(input: BacklogAddInput): Promise<BacklogEntry> {
    return this.entry(await this.options.store.add(input));
  }

  /** One more report of the item. The rank is the entry's alone: the others keep theirs. */
  async bump(id: string): Promise<BacklogEntry> {
    const row = await this.options.store.bump(id);
    if (!row) throw new BacklogItemNotFoundError(id);
    return this.entry(row);
  }

  /** The item becomes a card: its text, its first source and its scores as the card's hints; the item is removed. */
  async promote(id: string): Promise<TaskRow> {
    const item = await this.options.store.get(id);
    if (!item) throw new BacklogItemNotFoundError(id);
    const first = item.sources.find((s): s is TaskSource => "kind" in s);
    const task = await this.options.pipeline.createTask({
      title: item.title,
      description: item.text,
      ...(first ? { source: first } : {}),
      sources: item.sources,
      ...(item.repo?.startsWith("/") ? { repoPath: item.repo } : {}),
      hints: { size: item.size, urgency: String(item.scores.time) },
      ...(item.repo ? { links: {} } : {}),
    });
    await this.options.store.remove(id);
    return task;
  }

  async decline(id: string): Promise<void> {
    if (!(await this.options.store.remove(id))) throw new BacklogItemNotFoundError(id);
  }
}
