// The projector (RFC 0010, "Projection"): reads the machine's own records, builds the brain's rows and loads only what changed.
// The journal is the brain's own copy of every row written, because the machine prunes the records the rows come from: a diff reads it,
// and a rebuild loads it back. A load only adds edges, so an edge that moved or went away is removed first.
import { BRAIN_APPEND_ONLY, BRAIN_EDGES, BRAIN_QUERIES, brainSlug, brainTime, type BrainClaim, type BrainEdgeRow, type BrainNodeRow, type BrainRow, type DecisionRecord } from "@hardness/contracts";

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
  /** Slugs that must never be written again: a person asked for them to be forgotten. Absent means none. */
  forgotten?: string[];
}

export interface BrainJournal {
  read(): Promise<BrainState>;
  /** `dropPrevious` leaves no `.bak` behind, for a write that erased rows. */
  write(state: BrainState, options?: { dropPrevious?: boolean }): Promise<void>;
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

/** The node types of the claim layer, written as `luna-memories`; every other row is a fact, written as `luna-facts`. An edge belongs to the layer of the node it starts at. */
const CLAIM_LAYER = new Set(["Source", "Claim", "Learning"]);

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

/** The store's own clock for a claim when it gives one, else when the claim was made or decided, whichever is later (which never passes the store's `updated_at`, so a cursor at it re-reads, never skips). */
const claimTouched = (claim: BrainClaim): string => {
  const stored = claim.updatedAt;
  if (stored && !Number.isNaN(new Date(stored).getTime())) return brainTime(stored);
  const made = brainTime(claim.createdAt);
  const decided = claim.decidedAt && !Number.isNaN(new Date(claim.decidedAt).getTime()) ? brainTime(claim.decidedAt) : made;
  return decided > made ? decided : made;
};

/** Takes the forgotten nodes and the edges that touch them out of what a run built, then every node left under an edge's minimum by that, until none is. */
function dropForgotten(built: Map<string, BrainNodeRow>, builtEdges: Map<string, BrainEdgeRow>, forgotten: ReadonlySet<string>, log: (line: string) => void): void {
  const gone = new Set<string>();
  const drop = (slug: string): void => {
    gone.add(slug);
    built.delete(slug);
  };
  for (const slug of [...built.keys()]) if (forgotten.has(slug)) drop(slug);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, edge] of [...builtEdges]) {
      if (!forgotten.has(edge.from) && !forgotten.has(edge.to) && !gone.has(edge.from) && !gone.has(edge.to)) continue;
      builtEdges.delete(key);
      // The edge started at a node this run builds and needs one: that node cannot be loaded without it.
      const owner = built.get(edge.from);
      if (!owner || BRAIN_EDGES[edge.edge].min === 0) continue;
      const left = [...builtEdges.values()].filter((other) => other.edge === edge.edge && other.from === edge.from).length;
      if (left >= BRAIN_EDGES[edge.edge].min) continue;
      log(`brain: dropped ${edge.from}: it needs ${edge.edge}, and ${edge.to} was forgotten or dropped`);
      drop(edge.from);
      changed = true;
    }
  }
}

/** What a failure says: a BrainError by its code, never its message, since a message may carry the server's words. */
const describe = (error: unknown): string => (error instanceof BrainError ? `the brain refused the load: ${error.code}` : error instanceof Error ? error.message : String(error));

/** What a forget did: the nodes and edges it took out of the journal, and why it stopped when the graph refused (the error's code); null when it finished. */
export interface ForgetResult {
  nodes: number;
  edges: number;
  note: string | null;
}

export function brainProjector(deps: { brain: Brain; sources: BrainSources; journal: BrainJournal; log?: (line: string) => void; now?: () => Date }): { run(): Promise<ProjectionResult>; rebuild(): Promise<ProjectionResult>; forget(slugs: string[]): Promise<ForgetResult> } {
  const { brain, sources, journal } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
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

  /** Loads rows in the order a load needs: the facts first, then the claim layer as the memories actor, each in its own batches. `onBatch` runs after each lands. */
  async function loadLayers(rows: BrainRow[], typeOf: (slug: string) => string | undefined, onBatch: (batch: BrainRow[]) => Promise<void>): Promise<number> {
    const claimLayer = (row: BrainRow): boolean => CLAIM_LAYER.has("type" in row ? row.type : (typeOf(row.from) ?? ""));
    let loaded = 0;
    for (const layer of [{ rows: rows.filter((row) => !claimLayer(row)), actor: undefined }, { rows: rows.filter(claimLayer), actor: "memories" as const }]) {
      for (const batch of brainBatches(layer.rows)) {
        await (layer.actor ? brain.load(batch, { actor: layer.actor }) : brain.load(batch));
        await onBatch(batch);
        loaded += batch.length;
      }
    }
    return loaded;
  }

  /** Empties the graph and loads the journal's rows back. The flag is set before the reset and cleared after the last batch, so a stop in between is finished by the next run. */
  async function restore(state: BrainState): Promise<number> {
    state.rebuild = true;
    await journal.write(state);
    await brain.reset();
    const restored = await loadLayers([...Object.values(state.nodes), ...state.edges], (slug) => state.nodes[slug]?.type, async () => {});
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
    // The cards of this run that opened each PR, and the cards that only came from one, by slug and in task order.
    const openedPulls = new Map<string, Array<{ pull: BrainPull; taskId: string }>>();
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
          const into = pull.opened ? openedPulls : sourcePulls;
          into.set(slug, [...(into.get(slug) ?? []), { pull, taskId: task.id }]);
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
    // A PR has one card (PrForCard has a max of 1). Cards that opened it own it, and when two did (an address card reuses the PR it
    // came from) it is built once, for the one the journal already gives it to, else the first of the run. A pull request cards only
    // came from is built the same way, and only when no card of the run opened it. So a PR never gets two cards.
    const ownerOf = (slug: string, candidates: Array<{ pull: BrainPull; taskId: string }>) => {
      const owner = state.edges.find((edge) => edge.edge === "PrForCard" && edge.from === slug)?.to;
      return owner === undefined ? candidates[0] : candidates.find(({ taskId }) => brainSlug("card", taskId) === owner);
    };
    for (const [slug, candidates] of openedPulls) {
      const mine = ownerOf(slug, candidates) ?? candidates[0];
      if (mine) rows.push(...prRows(mine.pull, mine.taskId));
    }
    for (const [slug, candidates] of sourcePulls) {
      if (openedPulls.has(slug)) continue;
      const mine = ownerOf(slug, candidates);
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
      try {
        const pages = await sources.wikiPagesOf(task.repoPath);
        if (pages) rows.push(...pageRows(pages, repo));
      } catch (error) {
        log(`brain: skipped the wiki of ${task.repoPath}: ${describe(error)}`);
      }
    }
    // The wiki time is kept now, not at the end of a good run: with the server down, every projection would read every wiki again.
    if (JSON.stringify(wikiCursor) !== JSON.stringify(wikiSeen)) {
      state.cursor = { ...state.cursor, wiki: wikiCursor };
      await journal.write(state);
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
    // A record the journal already holds does not wait: it went in earlier without its card, and waiting only delays a change a person made.
    const waitsFor = (cardSlug: string | null, at: string, slugs: string[]): boolean =>
      cardSlug !== null && skippedCards.has(cardSlug) && !(cardSlug in state.nodes) && !slugs.every((slug) => slug in state.nodes) && now().getTime() - new Date(at).getTime() < CARD_WAIT_MS;
    let verdictCursor = state.cursor.verdicts;
    const verdictWaits: string[] = [];
    const verdictBuilt: string[] = [];
    for (const record of records) {
      const cardSlug = record.taskId ? brainSlug("card", record.taskId) : null;
      const wouldBuild = verdictRows(record, { hasCard: false }).flatMap((row) => ("type" in row ? [String(row.data.slug)] : []));
      if (waitsFor(cardSlug, touched(record), wouldBuild.length > 0 ? wouldBuild : [""])) {
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
      if (waitsFor(cardSlug, claimTouched(claim), [brainSlug("claim", claim.id)])) {
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

    // What a person asked to forget is never built, and neither is an edge to it. A node that needs an edge to a forgotten one (an edge's
    // minimum) goes too, and what needs that node in turn.
    const forgotten = new Set(state.forgotten ?? []);
    if (forgotten.size > 0) dropForgotten(built, builtEdges, forgotten, log);

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
      result.loaded += await loadLayers(toLoad, (slug) => built.get(slug)?.type ?? state.nodes[slug]?.type, async (batch) => {
        for (const row of batch) {
          if ("type" in row) state.nodes[String(row.data.slug)] = row;
          else state.edges.push(row);
        }
        await journal.write(state);
      });
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
    result.hygiene = await hygiene();
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

  /** Takes the slugs, and every edge that touches one, out of the graph and then out of the journal, and lists them as forgotten so no build writes them again. */
  async function forgetNow(slugs: string[]): Promise<ForgetResult> {
    const state = await journal.read();
    const targets = new Set(slugs);
    const nodes = Object.values(state.nodes).filter((node) => targets.has(String(node.data.slug)));
    const edges = state.edges.filter((edge) => targets.has(edge.from) || targets.has(edge.to));
    // The graph first: when it refuses, the journal is left as it was and the same call can be made again.
    if (brain.enabled) {
      try {
        for (const edge of edges) await brain.unlink(edge.edge, edge.from, edge.to);
        await brain.remove(nodes.map((node) => ({ type: node.type, slug: String(node.data.slug) })));
      } catch (error) {
        if (!(error instanceof BrainError)) throw error;
        log(`brain: forget stopped (${error.code})`);
        return { nodes: 0, edges: 0, note: error.code };
      }
    }
    for (const node of nodes) delete state.nodes[String(node.data.slug)];
    state.edges = state.edges.filter((edge) => !targets.has(edge.from) && !targets.has(edge.to));
    state.forgotten = [...new Set([...(state.forgotten ?? []), ...slugs])];
    await journal.write(state, { dropPrevious: true });
    return { nodes: nodes.length, edges: edges.length, note: null };
  }

  return {
    forget: (slugs) => serial(() => forgetNow(slugs)),
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
