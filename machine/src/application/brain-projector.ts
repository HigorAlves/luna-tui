// The projector (RFC 0010, "Projection"): reads the machine's own records, builds the brain's rows and loads only what changed.
// The journal is the brain's own copy of every row written, because the machine prunes the records the rows come from: a diff reads it,
// and a rebuild loads it back. A load only adds edges, so an edge that moved or went away is removed first.
import { BRAIN_APPEND_ONLY, BRAIN_QUERIES, brainSlug, brainTime, type BrainClaim, type BrainEdgeRow, type BrainNodeRow, type BrainRow, type DecisionRecord } from "@hardness/contracts";

import { brainBatches } from "../domain/brain/batches.ts";
import { type BrainPull, type BrainRepo, type RetroFacts, cardRows, prRows, repoRows, ticketRows } from "../domain/brain/rows.ts";
import { actorRows, componentRows } from "../domain/brain/rows-people.ts";
import { claimRows } from "../domain/brain/rows-claims.ts";
import { principleRows } from "../domain/brain/rows-principles.ts";
import { verdictRows } from "../domain/brain/rows-verdicts.ts";
import type { TaskRow } from "../domain/task.ts";
import { BrainError, type Brain } from "./brain.ts";

export interface BrainSources {
  /** Tasks whose `updatedAt` is at or after `since`; every task when null. */
  tasks(since: Date | null): Promise<TaskRow[]>;
  repoOf(repoPath: string): BrainRepo;
  retroOf(task: TaskRow): Promise<RetroFacts | null>;
  pullsOf(task: TaskRow): Promise<BrainPull[]>;
  componentsOf(task: TaskRow): Promise<string[]>;
  /** Decision records that have a truth, decided or learned at or after `since`; all of them when null. */
  verdicts(since: Date | null): Promise<DecisionRecord[]>;
  /** Claims updated at or after `since` whose status is not `refused`, oldest first; every one when null. */
  claims(since: Date | null): Promise<BrainClaim[]>;
  /** The person who runs the machine; null when it is not known. */
  owner(): Promise<{ actor: string; login: string } | null>;
  /** The text of the repository's `docs/agents/project-context.md` on its default branch; null when it has none or could not be read. */
  principlesOf(repoPath: string): Promise<string | null>;
}

export interface BrainState {
  /** How far the projection got: the newest `updatedAt` of a projected task, the newest verdict time and the newest claim time, as ISO strings. */
  cursor: { tasks: string | null; verdicts: string | null; claims: string | null };
  /** Every node row written, by slug. */
  nodes: Record<string, BrainNodeRow>;
  /** Every edge written. */
  edges: BrainEdgeRow[];
}

export interface BrainJournal {
  read(): Promise<BrainState>;
  write(state: BrainState): Promise<void>;
}

export interface ProjectionResult {
  tasks: number;
  loaded: number;
  skipped: number;
  unlinked: number;
  hygiene: Array<{ query: string; rows: number }>;
  note: string | null;
}

const OFF = "the brain is off";
const empty = (note: string | null): ProjectionResult => ({ tasks: 0, loaded: 0, skipped: 0, unlinked: 0, hygiene: [], note });

/** The node types whose edges the projector owns: when one is built again, an edge it no longer builds is removed. */
const OWNERS = new Set(["Card", "PR", "Component", "Actor", "Verdict", "Claim"]);

const edgeKey = (edge: BrainEdgeRow): string => `${edge.edge}\u0000${edge.from}\u0000${edge.to}`;
const sameData = (a: BrainNodeRow, b: BrainNodeRow): boolean => JSON.stringify(sortKeys(a.data)) === JSON.stringify(sortKeys(b.data)) && a.type === b.type;
const sortKeys = (data: BrainNodeRow["data"]) => Object.fromEntries(Object.entries(data).sort(([x], [y]) => (x < y ? -1 : 1)));
const newest = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a >= b ? a : b);

/** When a record was decided or its truth learned, whichever is later: what the verdict cursor follows, so a truth that came late is read once. */
const touched = (record: DecisionRecord): string => {
  const decided = brainTime(record.at);
  const learned = record.truth && !Number.isNaN(new Date(record.truth.at).getTime()) ? brainTime(record.truth.at) : decided;
  return learned > decided ? learned : decided;
};

/** When a claim was made or decided, whichever is later. It never passes the store's `updated_at`, so a cursor at it re-reads, never skips. */
const claimTouched = (claim: BrainClaim): string => {
  const made = brainTime(claim.createdAt);
  const decided = claim.decidedAt && !Number.isNaN(new Date(claim.decidedAt).getTime()) ? brainTime(claim.decidedAt) : made;
  return decided > made ? decided : made;
};

/** What a failure says: a BrainError by its code, never its message, since a message may carry the server's words. */
const describe = (error: unknown): string => (error instanceof BrainError ? `the brain refused the load: ${error.code}` : error instanceof Error ? error.message : String(error));

export function brainProjector(deps: { brain: Brain; sources: BrainSources; journal: BrainJournal; log?: (line: string) => void }): { run(): Promise<ProjectionResult>; rebuild(): Promise<ProjectionResult> } {
  const { brain, sources, journal } = deps;
  const log = deps.log ?? (() => {});

  let chain: Promise<unknown> = Promise.resolve();
  const serial = (job: () => Promise<ProjectionResult>): Promise<ProjectionResult> => {
    const next = chain.then(job);
    chain = next.catch(() => undefined);
    return next;
  };

  async function hygiene(): Promise<ProjectionResult["hygiene"]> {
    const found: ProjectionResult["hygiene"] = [];
    for (const query of BRAIN_QUERIES.filter((candidate) => candidate.hygiene)) {
      const answer = await brain.query(query.name);
      found.push({ query: query.name, rows: answer.rows.length });
      if (answer.rows.length > 0) log(`brain hygiene: ${query.name} returned ${answer.rows.length} row(s)`);
    }
    return found;
  }

  async function incremental(): Promise<ProjectionResult> {
    const state = await journal.read();
    const since = (value: string | null) => (value ? new Date(value) : null);
    const [tasks, records, claims] = await Promise.all([
      sources.tasks(since(state.cursor.tasks)),
      sources.verdicts(since(state.cursor.verdicts)),
      sources.claims(since(state.cursor.claims ?? null)),
    ]);

    const rows: BrainRow[] = [];
    const owner = await sources.owner();
    if (owner) rows.push(...actorRows(owner));
    let projected = 0;
    let skippedTask = false;
    let taskCursor = state.cursor.tasks;
    for (const task of tasks) {
      // A card that ended is final in the brain. The machine prunes a closed card's events and stage runs, so building it
      // again later would write its estimate, its retries and its components back as nothing.
      const held = state.nodes[brainSlug("card", task.id)];
      if (held && (task.state === "closed" || task.state === "archived") && held.data.state === task.state) {
        taskCursor = newest(taskCursor, brainTime(task.updatedAt));
        continue;
      }
      try {
        const repo = task.repoPath ? sources.repoOf(task.repoPath) : null;
        const [retro, pulls, components] = await Promise.all([sources.retroOf(task), sources.pullsOf(task), repo ? sources.componentsOf(task) : Promise.resolve([] as string[])]);
        rows.push(...(repo ? repoRows(repo) : []), ...cardRows(task, { repo, retro }), ...ticketRows(task));
        for (const pull of pulls) rows.push(...prRows(pull, task.id));
        if (repo) rows.push(...componentRows(components, repo, task.id));
        projected += 1;
        taskCursor = newest(taskCursor, brainTime(task.updatedAt));
      } catch (error) {
        skippedTask = true;
        log(`brain: skipped task ${task.id}: ${describe(error)}`);
      }
    }
    // A repository's principles come from its file as it stands now, once per repository of the run. A failure skips that repository.
    const read = new Set<string>();
    for (const task of tasks) {
      if (!task.repoPath) continue;
      try {
        const repo = sources.repoOf(task.repoPath);
        if (read.has(repo.slug)) continue;
        read.add(repo.slug);
        const prefix = `${brainSlug("principle", repo.slug)}/`;
        const held = Object.values(state.nodes).filter((node) => node.type === "Principle" && String(node.data.slug).startsWith(prefix));
        rows.push(...principleRows(await sources.principlesOf(task.repoPath), repo, { at: new Date(), held }));
      } catch (error) {
        log(`brain: skipped the principles of ${task.repoPath}: ${describe(error)}`);
      }
    }
    let verdictCursor = state.cursor.verdicts;
    for (const record of records) {
      rows.push(...verdictRows(record));
      verdictCursor = newest(verdictCursor, touched(record));
    }

    // A claim comes after the cards: its source is a card the graph holds, or one built in this run.
    let claimCursor = state.cursor.claims ?? null;
    const inRun = new Set(claims.map((claim) => brainSlug("claim", claim.id)));
    for (const claim of claims) {
      const cardSlug = claim.source.kind === "card" ? brainSlug("card", claim.source.ref) : null;
      const hasCard = cardSlug !== null && (cardSlug in state.nodes || rows.some((row) => "type" in row && row.data.slug === cardSlug));
      const repo = claim.repoPath ? sources.repoOf(claim.repoPath) : null;
      rows.push(...claimRows(claim, { repo, hasCard, knows: (id) => inRun.has(brainSlug("claim", id)) || brainSlug("claim", id) in state.nodes }));
      claimCursor = newest(claimCursor, claimTouched(claim));
    }

    // One row per slug and per edge: two tasks in one repository build the same Repo.
    const built = new Map<string, BrainNodeRow>();
    const builtEdges = new Map<string, BrainEdgeRow>();
    for (const row of rows) {
      if ("type" in row) built.set(String(row.data.slug), row);
      else builtEdges.set(edgeKey(row), row);
    }

    const result = empty(null);
    result.tasks = projected;

    // What moved or went away goes first: a load only adds edges.
    const stale = state.edges.filter((edge) => {
      const owner = built.get(edge.from);
      return owner !== undefined && OWNERS.has(owner.type) && !builtEdges.has(edgeKey(edge));
    });
    const kept = new Set(state.edges.map(edgeKey));
    try {
      for (const edge of stale) {
        await brain.unlink(edge.edge, edge.from, edge.to);
        kept.delete(edgeKey(edge));
        result.unlinked += 1;
      }
    } finally {
      if (result.unlinked > 0) {
        state.edges = state.edges.filter((edge) => kept.has(edgeKey(edge)));
        await journal.write(state);
      }
    }

    const haveEdges = new Set(state.edges.map(edgeKey));
    const toLoad: BrainRow[] = [];
    for (const [slug, row] of built) {
      const held = state.nodes[slug];
      if (held && sameData(held, row)) result.skipped += 1;
      else if (held && BRAIN_APPEND_ONLY.has(row.type)) {
        // A lesson is never rewritten, even when the claim under it was reworded.
        result.skipped += 1;
        log(`brain: kept ${slug}: a ${row.type} is never loaded again`);
      } else toLoad.push(row);
    }
    for (const [key, edge] of builtEdges) {
      if (haveEdges.has(key)) result.skipped += 1;
      else toLoad.push(edge);
    }

    try {
      for (const batch of brainBatches(toLoad)) {
        await brain.load(batch);
        for (const row of batch) {
          if ("type" in row) state.nodes[String(row.data.slug)] = row;
          else state.edges.push(row);
        }
        await journal.write(state);
        result.loaded += batch.length;
      }
    } catch (error) {
      result.note = describe(error);
      if (!(error instanceof BrainError)) log(`brain: ${result.note}`);
      return result;
    }

    if (!skippedTask) {
      state.cursor = { tasks: taskCursor, verdicts: verdictCursor, claims: claimCursor };
      if (state.cursor.tasks !== null || state.cursor.verdicts !== null || state.cursor.claims !== null) await journal.write(state);
    }
    if (result.loaded > 0 || result.unlinked > 0) result.hygiene = await hygiene();
    return result;
  }

  const guarded = async (job: () => Promise<ProjectionResult>): Promise<ProjectionResult> => {
    if (!brain.enabled) return empty(OFF);
    try {
      return await job();
    } catch (error) {
      const note = describe(error);
      log(`brain: ${note}`);
      return empty(note);
    }
  };

  return {
    run: () => serial(() => guarded(incremental)),
    rebuild: () =>
      serial(() =>
        guarded(async () => {
          await brain.reset();
          const state = await journal.read();
          const rows: BrainRow[] = [...Object.values(state.nodes), ...state.edges];
          let restored = 0;
          for (const batch of brainBatches(rows)) {
            await brain.load(batch);
            restored += batch.length;
          }
          const checked = rows.length > 0 ? await hygiene() : [];
          const next = await incremental();
          return { ...next, loaded: next.loaded + restored, hygiene: next.hygiene.length > 0 ? next.hygiene : checked };
        }),
      ),
  };
}

/** What a card's close calls: starts a projection and returns at once. A brain that is down or slow never fails or delays the close. */
export function projectAfterClose(projector: { run(): Promise<unknown> }, log: (line: string) => void = () => {}): () => void {
  return () => {
    try {
      projector.run().catch((error: unknown) => log(`brain: projection after a close failed: ${describe(error)}`));
    } catch (error) {
      log(`brain: projection after a close failed: ${describe(error)}`);
    }
  };
}
