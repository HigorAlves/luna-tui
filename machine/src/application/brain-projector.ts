// The projector (RFC 0010, "Projection"): reads the machine's own records, builds the brain's rows and loads only what changed.
// The journal is the brain's own copy of every row written, because the machine prunes the records the rows come from: a diff reads it,
// and a rebuild loads it back. A load only adds edges, so an edge that moved or went away is removed first.
import { BRAIN_APPEND_ONLY, BRAIN_QUERIES, brainSlug, brainTime, type BrainClaim, type BrainEdgeRow, type BrainNodeRow, type BrainRow, type DecisionRecord } from "@hardness/contracts";

import { brainBatches } from "../domain/brain/batches.ts";
import { type BrainPull, type BrainRepo, type RetroFacts, cardRows, prRows, repoRows, ticketRows } from "../domain/brain/rows.ts";
import { actorRows, componentRows } from "../domain/brain/rows-people.ts";
import { claimRows } from "../domain/brain/rows-claims.ts";
import { incidentRows, pageRows, regimeRows } from "../domain/brain/rows-compliance.ts";
import { principleRows } from "../domain/brain/rows-principles.ts";
import { verdictRows } from "../domain/brain/rows-verdicts.ts";
import type { Incident } from "../domain/incident.ts";
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
  /** Every stored incident; empty when the machine has no incident job. */
  incidents(): Promise<Incident[]>;
  /** The regimes the repository's `luna.yaml` declares under `compliance`; empty when it declares none, null when it could not be read. */
  regimesOf(repoPath: string): Promise<string[] | null>;
  /** The wiki's pages under `Compliance/Controls/`, `Policies/` and `Answers/`; null when the repository has no GitHub slug the machine knows, wikis cannot be reached, or the read failed. */
  wikiPagesOf(repoPath: string): Promise<{ path: string; text: string }[] | null>;
}

export interface BrainState {
  /** How far the projection got: the newest `updatedAt` of a projected task, the newest verdict time and the newest claim time, as ISO
   *  strings, and the time each repository's wiki was last read, by the repository's slug. */
  cursor: { tasks: string | null; verdicts: string | null; claims: string | null; wiki: Record<string, string> };
  /** Every node row written, by slug. */
  nodes: Record<string, BrainNodeRow>;
  /** Every edge written. */
  edges: BrainEdgeRow[];
  /** A rebuild began and did not finish: the graph may hold less than the rows above. The next run restores it first. Absent means not set. */
  rebuild?: true;
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
const OWNERS = new Set(["Card", "PR", "Component", "Actor", "Verdict", "Claim", "Incident"]);

/** How long a verdict or a claim waits for a card whose task failed. After that it goes in without its card, so a task that never
 *  stops failing cannot hold the records behind it for ever. */
const CARD_WAIT_MS = 24 * 3_600_000;

/** A repository's wiki is read over the network, so at most this often. */
const WIKI_EVERY_MS = 24 * 3_600_000;

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

export function brainProjector(deps: { brain: Brain; sources: BrainSources; journal: BrainJournal; log?: (line: string) => void; now?: () => Date }): { run(): Promise<ProjectionResult>; rebuild(): Promise<ProjectionResult> } {
  const { brain, sources, journal } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());

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

  /** Empties the graph and loads the journal's rows back. The flag is set before the reset and cleared after the last batch, so a stop in between is finished by the next run. */
  async function restore(state: BrainState): Promise<number> {
    state.rebuild = true;
    await journal.write(state);
    await brain.reset();
    let restored = 0;
    for (const batch of brainBatches([...Object.values(state.nodes), ...state.edges])) {
      await brain.load(batch);
      restored += batch.length;
    }
    delete state.rebuild;
    await journal.write(state);
    return restored;
  }

  async function incremental(): Promise<ProjectionResult> {
    const state = await journal.read();
    const restored = state.rebuild ? await restore(state) : 0;
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
    // The cards of the tasks that failed this run: a verdict or claim about one waits, since its card edge would be lost.
    const skippedCards = new Set<string>();
    // The PRs a card of this run opened, and the PRs a card only came from, by slug and in task order.
    const openedPrs = new Set<string>();
    const sourcePulls = new Map<string, Array<{ pull: BrainPull; taskId: string }>>();
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
        for (const pull of pulls) {
          const slug = brainSlug("pr", `${pull.repo}#${pull.number}`);
          if (pull.opened) {
            openedPrs.add(slug);
            rows.push(...prRows(pull, task.id));
          } else sourcePulls.set(slug, [...(sourcePulls.get(slug) ?? []), { pull, taskId: task.id }]);
        }
        if (repo) rows.push(...componentRows(components, repo, task.id));
        projected += 1;
        taskCursor = newest(taskCursor, brainTime(task.updatedAt));
      } catch (error) {
        skippedTask = true;
        skippedCards.add(brainSlug("card", task.id));
        log(`brain: skipped task ${task.id}: ${describe(error)}`);
      }
    }
    // The card that opened a PR owns it. A pull request a card only came from is built for one card: the one the journal already
    // gives it to, else the first of the run. So a PR a person opened stays current through its one card, and never gets two.
    for (const [slug, candidates] of sourcePulls) {
      if (openedPrs.has(slug)) continue;
      const owner = state.edges.find((edge) => edge.edge === "PrForCard" && edge.from === slug)?.to;
      const mine = owner === undefined ? candidates[0] : candidates.find(({ taskId }) => brainSlug("card", taskId) === owner);
      if (mine) rows.push(...prRows(mine.pull, mine.taskId));
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
    // A repository's regimes come from its luna.yaml as it stands now, and its compliance pages from its wiki, at most once a day
    // each. A failure skips that repository's part and nothing else. A repository whose regimes were read owns its RepoUnderRegime
    // edges; one whose file could not be read keeps what it had.
    const regimeOwners = new Set<string>();
    const wikiSeen = state.cursor.wiki ?? {};
    const wikiCursor = { ...wikiSeen };
    let wikiRead = false;
    const compliance = new Set<string>();
    for (const task of tasks) {
      if (!task.repoPath) continue;
      let repo: BrainRepo;
      try {
        repo = sources.repoOf(task.repoPath);
      } catch (error) {
        log(`brain: skipped the compliance of ${task.repoPath}: ${describe(error)}`);
        continue;
      }
      if (compliance.has(repo.slug)) continue;
      compliance.add(repo.slug);
      try {
        const regimes = await sources.regimesOf(task.repoPath);
        if (regimes) {
          rows.push(...regimeRows(repo, regimes));
          regimeOwners.add(brainSlug("repo", repo.slug));
        }
      } catch (error) {
        log(`brain: skipped the regimes of ${task.repoPath}: ${describe(error)}`);
      }
      const seen = wikiSeen[repo.slug];
      if (seen !== undefined && now().getTime() - new Date(seen).getTime() <= WIKI_EVERY_MS) continue;
      // The time moves even when the read fails: a wiki that is down is asked again tomorrow, not on every card.
      wikiCursor[repo.slug] = now().toISOString();
      wikiRead = true;
      try {
        const pages = await sources.wikiPagesOf(task.repoPath);
        if (pages) rows.push(...pageRows(pages, repo));
      } catch (error) {
        log(`brain: skipped the wiki of ${task.repoPath}: ${describe(error)}`);
      }
    }
    try {
      for (const incident of await sources.incidents()) rows.push(...incidentRows(incident));
    } catch (error) {
      log(`brain: skipped the incidents: ${describe(error)}`);
    }

    const slugsBuilt = new Set<string>();
    for (const row of rows) if ("type" in row) slugsBuilt.add(String(row.data.slug));
    const hasCard = (slug: string): boolean => slug in state.nodes || slugsBuilt.has(slug);

    // A verdict or claim about a card the graph does not hold yet, whose task failed this run, waits for the next one, and its cursor may
    // not pass it: the rest are built and their cursor moves, so one task that keeps failing does not freeze them. It waits a day at
    // most, then goes in without its card. `held` is the oldest time among those that wait.
    const waitsFor = (cardSlug: string | null, at: string): boolean =>
      cardSlug !== null && skippedCards.has(cardSlug) && !(cardSlug in state.nodes) && now().getTime() - new Date(at).getTime() < CARD_WAIT_MS;
    let verdictCursor = state.cursor.verdicts;
    const verdictWaits: string[] = [];
    const verdictBuilt: string[] = [];
    for (const record of records) {
      const cardSlug = record.taskId ? brainSlug("card", record.taskId) : null;
      if (waitsFor(cardSlug, touched(record))) {
        verdictWaits.push(touched(record));
        continue;
      }
      rows.push(...verdictRows(record, { hasCard: cardSlug !== null && hasCard(cardSlug) }));
      verdictBuilt.push(touched(record));
    }
    const verdictHeld = verdictWaits.sort()[0];
    for (const at of verdictBuilt) if (verdictHeld === undefined || at < verdictHeld) verdictCursor = newest(verdictCursor, at);

    // A claim comes after the cards: its source is a card the graph holds, or one built in this run.
    let claimCursor = state.cursor.claims ?? null;
    const claimWaits: string[] = [];
    const claimBuilt: string[] = [];
    const inRun = new Set(claims.map((claim) => brainSlug("claim", claim.id)));
    // A card's Source keeps the time the journal holds, else the earliest of this run's claims of the card.
    const sourceTimes = new Map<string, string>();
    for (const claim of claims) {
      if (claim.source.kind !== "card") continue;
      const slug = brainSlug("source", `card/${claim.source.ref}`);
      const at = brainTime(claim.createdAt);
      const first = sourceTimes.get(slug);
      if (first === undefined || at < first) sourceTimes.set(slug, at);
    }
    for (const claim of claims) {
      const cardSlug = claim.source.kind === "card" ? brainSlug("card", claim.source.ref) : null;
      if (waitsFor(cardSlug, claimTouched(claim))) {
        claimWaits.push(claimTouched(claim));
        continue;
      }
      const repo = claim.repoPath ? sources.repoOf(claim.repoPath) : null;
      const sourceSlug = brainSlug("source", `card/${claim.source.ref}`);
      const heldAt = state.nodes[sourceSlug]?.data.occurred_at;
      const sourceAt = typeof heldAt === "string" ? heldAt : (sourceTimes.get(sourceSlug) ?? claim.createdAt);
      rows.push(...claimRows(claim, { repo, hasCard: cardSlug !== null && hasCard(cardSlug), sourceAt, knows: (id) => inRun.has(brainSlug("claim", id)) || brainSlug("claim", id) in state.nodes }));
      claimBuilt.push(claimTouched(claim));
    }
    const claimHeld = claimWaits.sort()[0];
    for (const at of claimBuilt) if (claimHeld === undefined || at < claimHeld) claimCursor = newest(claimCursor, at);

    // One row per slug and per edge: two tasks in one repository build the same Repo.
    const built = new Map<string, BrainNodeRow>();
    const builtEdges = new Map<string, BrainEdgeRow>();
    for (const row of rows) {
      if ("type" in row) built.set(String(row.data.slug), row);
      else builtEdges.set(edgeKey(row), row);
    }

    const result = empty(null);
    result.tasks = projected;
    result.loaded = restored;

    // What moved or went away goes first: a load only adds edges.
    const stale = state.edges.filter((edge) => {
      const owner = built.get(edge.from);
      if (builtEdges.has(edgeKey(edge))) return false;
      return (owner !== undefined && OWNERS.has(owner.type)) || (edge.edge === "RepoUnderRegime" && regimeOwners.has(edge.from));
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

    // A skipped task holds the tasks cursor; the others move all the same.
    const next = { tasks: skippedTask ? state.cursor.tasks : taskCursor, verdicts: verdictCursor, claims: claimCursor, wiki: wikiCursor };
    if (JSON.stringify(next) !== JSON.stringify({ ...state.cursor, claims: state.cursor.claims ?? null })) {
      state.cursor = next;
      await journal.write(state);
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
          // The journal is read first: one that cannot be read must leave the graph as it is.
          const state = await journal.read();
          const restored = await restore(state);
          const checked = restored > 0 ? await hygiene() : [];
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
