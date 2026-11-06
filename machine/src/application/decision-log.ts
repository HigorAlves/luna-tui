// The decision log: one file per decision pack call, under the machine's state dir (never a repo):
// `<stateDir>/decisions/<pack>/<yyyy-mm-dd>/<id>.json`, owner-only. Contexts carry repo paths and
// code excerpts, so the files stay on this machine; `pnpm eval harvest` scrubs before anything
// reaches `evals/`. Written atomically (temp file, then rename); pruned by `pruneLearning` (`learning-prune.ts`).
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DecisionRecord, type DecisionTruth, type PackId, type TruthKind } from "@hardness/contracts";

export const DECISIONS_DIR = "decisions";
/** A record id is a file name: letters, digits, dots, dashes, underscores; never a path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const HISTORY_MAX = 20;
/** For one question a person's word at the board or the command line beats a fact, a fact beats a label pulled from the queue (the trace tool holds the data it came from), that beats an outcome; a truth with no kind is a fact. */
const RANK: Record<TruthKind, number> = { person: 4, fact: 3, queue: 2, outcome: 1 };
const kindOf = (truth: Pick<DecisionTruth, "kind">): TruthKind => truth.kind ?? "fact";

/** `incoming` laid over `existing` by question: it takes a question when its kind ranks at least as high as the label there
 *  (among equals the later wins). `source`, `kind` and `at` are those of the latest fact that changed a label; `history` keeps
 *  each fact that did, the 20 latest. The same object comes back when nothing changed. */
export function mergeTruth(existing: DecisionTruth | undefined, incoming: DecisionTruth): DecisionTruth {
  const kind = kindOf(incoming);
  const existingKinds = new Map<string, TruthKind>();
  const history = existing ? (existing.history ?? [{ label: existing.label, source: existing.source, kind: kindOf(existing), at: existing.at }]) : [];
  // The kind a question's label has: the per-question kinds kept beside the truth, else the latest history entry that names it, else the truth's own.
  for (const entry of history) for (const question of Object.keys(entry.label)) existingKinds.set(question, entry.kind);
  for (const [question, held] of Object.entries(existing?.kinds ?? {})) existingKinds.set(question, held);
  const applied: Record<string, unknown> = {};
  for (const [question, value] of Object.entries(incoming.label)) {
    const held = existing && question in existing.label ? (existingKinds.get(question) ?? kindOf(existing)) : null;
    if (held === null) applied[question] = value;
    // The same label from a kind that does not rank higher changes nothing: no entry.
    else if (RANK[kind] >= RANK[held] && (JSON.stringify(existing!.label[question]) !== JSON.stringify(value) || RANK[kind] > RANK[held])) applied[question] = value;
  }
  if (existing && Object.keys(applied).length === 0) return existing;
  const next = [...history, { label: applied, source: incoming.source, kind, at: incoming.at }].slice(-HISTORY_MAX);
  const kinds = { ...Object.fromEntries(Object.keys(existing?.label ?? {}).map((question) => [question, existingKinds.get(question) ?? kindOf(existing!)])), ...Object.fromEntries(Object.keys(applied).map((question) => [question, kind])) };
  return { label: { ...(existing?.label ?? {}), ...applied }, source: incoming.source, at: incoming.at, kind, ...(incoming.note ? { note: incoming.note } : existing?.note ? { note: existing.note } : {}), history: next, kinds };
}

export interface DecisionAppender {
  append(record: DecisionRecord): Promise<void>;
}

export interface DecisionLogOptions {
  stateDir: string;
  /** `MACHINE_DECISIONS=off` writes nothing. */
  enabled?: boolean;
}

export class DecisionLog implements DecisionAppender {
  private readonly root: string;
  private readonly enabled: boolean;

  constructor(options: DecisionLogOptions) {
    this.root = join(options.stateDir, DECISIONS_DIR);
    this.enabled = options.enabled ?? true;
  }

  async append(record: DecisionRecord): Promise<void> {
    if (!this.enabled) return;
    if (!SAFE_ID.test(record.id)) throw new Error(`decision record id is not a file name: ${record.id}`);
    const dir = join(this.root, record.pack, record.at.slice(0, 10));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.write(join(dir, `${record.id}.json`), record);
  }

  /** A pack's records, oldest first; `since` keeps those at or after it, `withTruth` those with a truth. */
  async list(pack: PackId, options: { since?: Date; withTruth?: boolean } = {}): Promise<DecisionRecord[]> {
    const records: DecisionRecord[] = [];
    for (const day of await this.days(pack)) {
      for (const name of await readdir(join(this.root, pack, day)).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        const record = await this.load(join(this.root, pack, day, name));
        if (!record) continue;
        if (options.since && new Date(record.at) < options.since) continue;
        if (options.withTruth && !record.truth) continue;
        records.push(record);
      }
    }
    return records.sort((a, b) => a.at.localeCompare(b.at));
  }

  async read(pack: PackId, id: string): Promise<DecisionRecord | null> {
    const path = await this.locate(pack, id);
    return path ? this.load(path) : null;
  }

  /** Adds the truth to the record's, question by question (see `mergeTruth`); false when there is no such record (or the log is off). */
  async setTruth(pack: PackId, id: string, truth: DecisionTruth): Promise<boolean> {
    const path = await this.locate(pack, id);
    const record = path ? await this.load(path) : null;
    if (!path || !record) return false;
    const merged = mergeTruth(record.truth, truth);
    if (merged !== record.truth) await this.write(path, { ...record, truth: merged });
    return true;
  }

  private async days(pack: PackId): Promise<string[]> {
    return (await readdir(join(this.root, pack)).catch(() => [])).filter((name) => DAY.test(name)).sort();
  }

  private async locate(pack: PackId, id: string): Promise<string | null> {
    if (!SAFE_ID.test(id)) return null;
    for (const day of await this.days(pack)) {
      const path = join(this.root, pack, day, `${id}.json`);
      if (await readFile(path).then(() => true, () => false)) return path;
    }
    return null;
  }

  private async load(path: string): Promise<DecisionRecord | null> {
    try {
      return DecisionRecord.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return null;
    }
  }

  private async write(path: string, record: DecisionRecord): Promise<void> {
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
