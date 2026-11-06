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
  /** Demand minus one (never under 1): the undo of a bump. */
  unbump(id: string): Promise<BacklogRow | null>;
  remove(id: string): Promise<boolean>;
  /** Every item that names `from` names `to` instead: one statement. */
  replaceDependency(from: string, to: string): Promise<void>;
  /** New scores and size for an item (a ticket assessed again); it counts as assessed now and keeps its demand. */
  rescore(id: string, change: { text: string; scores: BacklogScores; size: BacklogSize }): Promise<BacklogRow | null>;
}

export class BacklogItemNotFoundError extends Error {
  constructor(id: string) {
    super(`backlog item ${id} not found`);
    this.name = "BacklogItemNotFoundError";
  }
}

export interface BacklogOptions {
  store: BacklogStore;
  pipeline: { createTask(input: NewTask): Promise<TaskRow>; dependencyStates?(ids: readonly string[]): Promise<Map<string, { state: string; satisfied: boolean }>> };
  /** `backlog.stale_days`. */
  staleDays?: number;
  now?: () => Date;
  /** Called after a declined item has been removed (the ticket machine drafts the decline reply for a ticket's item). Never throws into the caller. */
  onDecline?: (row: BacklogRow) => Promise<void>;
}

/** The item waits for something: 409 `not_schedulable`, with what. Nothing was removed. */
export class NotSchedulableError extends Error {
  constructor(readonly blockedBy: NonNullable<BacklogEntry["blockedBy"]>) {
    super(`this item waits for ${blockedBy.length} dependenc${blockedBy.length === 1 ? "y" : "ies"} that are not there yet`);
    this.name = "NotSchedulableError";
  }
}

export class Backlog {
  private readonly staleDays: number;
  private readonly now: () => Date;

  constructor(private readonly options: BacklogOptions) {
    this.staleDays = options.staleDays ?? FACTORY_DEFAULTS.backlog.stale_days;
    this.now = options.now ?? (() => new Date());
  }

  /** What each item waits for: an item still in `all` blocks; a card blocks unless the dependency rule calls it satisfied; an id that is neither is gone. */
  private async blockers(rows: BacklogRow[], all: BacklogRow[]): Promise<Map<string, NonNullable<BacklogEntry["blockedBy"]>>> {
    const items = new Set(all.map((r) => r.id));
    const wanted = [...new Set(rows.flatMap((r) => r.dependsOn).filter((id) => !items.has(id)))];
    // A read that fails (or a pipeline that cannot be asked) leaves the states unknown: every card dependency then blocks.
    const read = wanted.length > 0 && this.options.pipeline.dependencyStates ? await this.options.pipeline.dependencyStates(wanted).catch((): null => null) : wanted.length > 0 ? null : new Map<string, { state: string; satisfied: boolean }>();
    const cards = read ?? new Map<string, { state: string; satisfied: boolean }>();
    return new Map(
      rows.map((r) => [
        r.id,
        r.dependsOn.flatMap((id): NonNullable<BacklogEntry["blockedBy"]> => {
          if (items.has(id)) return [{ id, kind: "item", state: "in the backlog" }];
          if (read === null) return [{ id, kind: "card", state: "unreadable" }];
          const card = cards.get(id);
          return card && !card.satisfied ? [{ id, kind: "card", state: card.state }] : [];
        }),
      ]),
    );
  }

  private async entries(rows: BacklogRow[], all: BacklogRow[] = rows): Promise<BacklogEntry[]> {
    const blocked = await this.blockers(rows, all);
    const ranked = rankBacklog(rows, { now: this.now(), staleDays: this.staleDays });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ranked.map((r) => {
      const row = byId.get(r.id)!;
      return { id: row.id, title: row.title, text: row.text, sources: row.sources, repo: row.repo, scores: row.scores, size: row.size, demand: row.demand, dependsOn: row.dependsOn, addedAt: row.addedAt.toISOString(), assessedAt: row.assessedAt.toISOString(), score: r.score, stale: r.stale, schedulable: (blocked.get(row.id) ?? []).length === 0, blockedBy: blocked.get(row.id) ?? [] };
    });
  }

  private async entry(row: BacklogRow): Promise<BacklogEntry> {
    return (await this.entries([row], await this.options.store.list()))[0]!;
  }

  async list(): Promise<BacklogEntry[]> {
    const rows = await this.options.store.list();
    return this.entries(rows);
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

  /** The undo of a bump (an unmerged duplicate). */
  async unbump(id: string): Promise<void> {
    await this.options.store.unbump(id);
  }

  /** The item becomes a card: its text, its first source and its scores as the card's hints. The item is removed FIRST and the card made only when this call removed it,
   *  so two promotes at once make one card; if making it fails the item is put back. */
  async promote(id: string): Promise<TaskRow> {
    const item = await this.options.store.get(id);
    if (!item) throw new BacklogItemNotFoundError(id);
    const all = await this.options.store.list();
    const blockedBy = (await this.blockers([item], all)).get(id) ?? [];
    if (blockedBy.length > 0) throw new NotSchedulableError(blockedBy);
    // Its dependencies that are cards: what the new card waits for (an id that is gone is dropped).
    const cardDeps = item.dependsOn.length > 0 && this.options.pipeline.dependencyStates ? [...(await this.options.pipeline.dependencyStates(item.dependsOn)).keys()] : [];
    if (!(await this.options.store.remove(id))) throw new BacklogItemNotFoundError(id);
    const first = item.sources.find((s): s is TaskSource => "kind" in s);
    try {
      const made = await this.options.pipeline.createTask({
        title: item.title,
        description: item.text,
        ...(first ? { source: first } : {}),
        sources: item.sources,
        ...(item.repo?.startsWith("/") ? { repoPath: item.repo } : {}),
        hints: { size: item.size, urgency: String(item.scores.time) },
        ...(item.repo ? { links: {} } : {}),
        ...(cardDeps.length > 0 ? { stack: { dependsOn: cardDeps } } : {}),
      });
      // Every other item that named this one now names the card.
      await this.options.store.replaceDependency(id, made.id).catch((error: unknown) => console.warn(`backlog: dependencies were not moved to the new card: ${error instanceof Error ? error.message : String(error)}`));
      return made;
    } catch (error) {
      await this.options.store.add({ title: item.title, text: item.text, sources: item.sources, repo: item.repo, scores: item.scores, size: item.size, dependsOn: item.dependsOn }).catch(() => undefined);
      throw error;
    }
  }

  async decline(id: string): Promise<void> {
    const row = await this.options.store.get(id);
    if (!(await this.options.store.remove(id))) throw new BacklogItemNotFoundError(id);
    if (row && this.options.onDecline) await this.options.onDecline(row).catch((error: unknown) => console.warn(`backlog: decline hook failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** A candidate that comes from a ticket: the item with the same first source is updated (scores, size: its rank follows), else added when `createIfMissing`. Never twice. */
  async upsertFromSource(input: BacklogAddInput, options: { createIfMissing: boolean }): Promise<{ id: string; created: boolean } | null> {
    const first = input.sources.find((s): s is TaskSource => "kind" in s);
    const found = first ? (await this.options.store.list()).find((r) => r.sources.some((s) => sameSource(s, first))) : undefined;
    if (found) {
      const row = await this.options.store.rescore(found.id, { text: input.text, scores: input.scores, size: input.size });
      return row ? { id: row.id, created: false } : null;
    }
    if (!options.createIfMissing) return null;
    return { id: (await this.options.store.add(input)).id, created: true };
  }
}

/** The same ticket: a Jira key, a GitHub repository and number, or a Slack thread (channel and root ts). */
export function sameSource(a: unknown, b: TaskSource): boolean {
  const x = a as Record<string, unknown>;
  if (b.kind === "jira") return x.kind === "jira" && x.key === b.key;
  if (b.kind === "github") return x.kind === "github" && x.repo === b.repo && x.number === b.number;
  if (b.kind === "slack") return x.kind === "slack" && x.channel === b.channel && x.ts === b.ts;
  return false;
}
