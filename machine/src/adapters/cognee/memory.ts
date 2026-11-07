// The Memory port over Cognee and the `memory_items` table (RFC 0007). Cognee holds the content and the graph; this holds the rest: each
// item's row (where it came from, what it is anchored to, whether it is trusted), the visibility rule (`datasetsFor` picks the datasets a
// viewer's search may name), the daily cap on `cognify`, and the lifecycle (pending, active, stale, retired). A write is a row first, then an
// add, so a Cognee that is down loses nothing: the row stays `pending` and `retryPending()` sends it later. Recall never throws.
import { randomBytes } from "node:crypto";
import { MEMORY_CONTEXT_MAX_BYTES, MEMORY_CONTEXT_MAX_ITEMS, MEMORY_TEXT_MAX, companyMemoryId, memoryMarker, type MemoryFloor, type MemoryItem, type MemoryStatus, type RecalledMemory } from "@hardness/contracts";

import type { CodeOperation, Memory, MemoryAnswer, MemoryItemDraft, MemoryListFilter, MemoryUsage, RecallQuery, RecallResult } from "../../application/memory.ts";
import type { MemoryStore } from "../../application/memory-store.ts";
import { COMPANY_DATASET, datasetFor, datasetsFor } from "../../domain/memory-datasets.ts";
import { type CogneeClient, type CogneeDataset, type CogneeSearchEntry, md5 } from "./client.ts";

/** Where Cognee's container sees the code graph's copies (`<state>/memory/code` is mounted there). */
export const CODE_ROOT = "/repos";
export const DEFAULT_DAILY_COGNIFY_ITEMS = 200;
export const RECALL_BUDGET_MS = 2000;
const DATASET_TTL_MS = 30_000;
const USAGE_TTL_MS = 60_000;
/** More chunks than the cap, since some belong to retired, outside or other-scope items and are dropped. */
const SEARCH_TOP_K = 30;
const DOC_CHUNK_MAX = 600;
const RETRY_BATCH = 50;
/** How long a dataset whose cognify failed waits before the retry loop builds it again. */
const COGNIFY_RETRY_MS = 15 * 60_000;

export interface MemoryServiceOptions {
  client: CogneeClient;
  store: MemoryStore;
  /** `openai` when Cognee has its own key, `local` without. */
  mode: "openai" | "local";
  /** Items `cognify` may process in a day, machine-wide. */
  dailyCognifyItems?: number;
  now?: () => Date;
  /** A machine event: dataset, item count, duration. */
  log?: (event: Record<string, unknown>) => void;
  recallBudgetMs?: number;
}

export interface MemoryService extends Memory {
  /** Sends the rows still `pending` to Cognee. Never throws. */
  retryPending(): Promise<{ sent: number; pending: number }>;
  /** What the Floor shows. Never throws. */
  floor(): Promise<MemoryFloor>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const isDocs = (name: string): boolean => name === COMPANY_DATASET || name.endsWith(":docs");
const isCode = (name: string): boolean => name.startsWith("code:");
const inScope = (name: string, scope: NonNullable<RecallQuery["scope"]>): boolean => (scope === "all" ? true : scope === "docs" ? isDocs(name) : scope === "code" ? isCode(name) : !isDocs(name) && !isCode(name));

const MIME: Record<string, string> = { md: "text/markdown", markdown: "text/markdown", txt: "text/plain", pdf: "application/pdf" };
const mimeOf = (name: string): string => MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** The `luna:<id>` first line of an item's chunk. */
const lunaMarker = (text: string): string | null => /^luna:([A-Za-z0-9_-]{1,64})(?:\s|$)/.exec(text)?.[1] ?? null;

/** What a dataset name says about the source of an item found in it with no row of ours. */
function sourceOfDataset(dataset: string): { repo: string | null; kind: MemoryItem["source"]["kind"] } {
  if (dataset === COMPANY_DATASET) return { repo: null, kind: "doc" };
  if (isCode(dataset)) return { repo: dataset.slice("code:".length), kind: "code" };
  const [repo = dataset, kind] = dataset.split(":");
  const known = (["github", "slack", "jira", "tui"] as const).find((k) => k === kind);
  return { repo, kind: known ?? "doc" };
}

/** Tokens and USD out of `GET /sessions/cost-by-model`, whose shape the keyless spike could not see: any rows carrying token or cost numbers are added up. */
export function usageOf(body: unknown): { tokens: number | null; costUsd: number | null } {
  let tokens: number | null = null;
  let cost: number | null = null;
  const num = (row: Record<string, unknown>, ...keys: string[]): number | null => {
    for (const key of keys) if (typeof row[key] === "number" && Number.isFinite(row[key])) return row[key] as number;
    return null;
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(value)) return void value.forEach((v) => visit(v, depth + 1));
    if (!isRecord(value)) return;
    const own = num(value, "total_tokens", "tokens");
    const split = num(value, "prompt_tokens", "input_tokens") !== null || num(value, "completion_tokens", "output_tokens") !== null ? (num(value, "prompt_tokens", "input_tokens") ?? 0) + (num(value, "completion_tokens", "output_tokens") ?? 0) : null;
    const rowTokens = own ?? split;
    const rowCost = num(value, "total_cost", "cost_usd", "cost");
    if (rowTokens !== null || rowCost !== null) {
      if (rowTokens !== null) tokens = (tokens ?? 0) + rowTokens;
      if (rowCost !== null) cost = (cost ?? 0) + rowCost;
      return;
    }
    for (const inner of Object.values(value)) visit(inner, depth + 1);
  };
  visit(body, 0);
  return { tokens, costUsd: cost };
}

export function cogneeMemory(options: MemoryServiceOptions): MemoryService {
  const { client, store } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const cap = options.dailyCognifyItems ?? DEFAULT_DAILY_COGNIFY_ITEMS;
  const budget = options.recallBudgetMs ?? RECALL_BUDGET_MS;
  const newId = (repo: string | null = null): string => (repo === null ? companyMemoryId(randomBytes(8).toString("hex")) : `mem_${randomBytes(8).toString("hex")}`);

  let lastError: string | null = null;
  let lastCognifyError: string | null = null;
  let datasetCache: { at: number; list: CogneeDataset[] } | null = null;
  let usageCache: { at: number; value: MemoryUsage } | null = null;

  /** One at a time: a write, a retry and a cognify never add the same row twice. */
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  let cognifyChain: Promise<unknown> = Promise.resolve();
  const cognifyExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = cognifyChain.then(fn, fn);
    cognifyChain = run.catch(() => {});
    return run;
  };

  /** The datasets Cognee holds, cached for 30 s; a stale list is still better than none when Cognee does not answer. */
  async function datasetList(timeoutMs: number, force = false): Promise<CogneeDataset[]> {
    if (!force && datasetCache && Date.now() - datasetCache.at < DATASET_TTL_MS) return datasetCache.list;
    try {
      const list = await client.datasets(timeoutMs);
      datasetCache = { at: Date.now(), list };
      return list;
    } catch (error) {
      if (datasetCache) return datasetCache.list;
      throw error;
    }
  }
  const noteDataset = (id: string, name: string): void => {
    const list = datasetCache?.list ?? [];
    datasetCache = { at: datasetCache?.at ?? 0, list: list.some((d) => d.name === name) ? list : [...list, { id, name }] };
  };

  async function retireData(row: MemoryItem, note: string): Promise<void> {
    if (row.cogneeDataId && row.dataset.id) {
      try {
        await client.deleteData(row.dataset.id, row.cogneeDataId);
      } catch (error) {
        lastError = message(error);
        log({ event: "memory.forget_failed", id: row.id, error: lastError });
        await store.setStatus(row.id, "retired", note, true);
        return;
      }
    }
    await store.setStatus(row.id, "retired", note, false);
  }

  /** Adds the rows that are still `pending` (re-read inside the lock), one add per dataset. */
  function flush(ids: readonly string[]): Promise<void> {
    return exclusive(async () => {
      const rows = (await store.getMany(ids)).filter((r) => r.status === "pending");
      const groups = new Map<string, MemoryItem[]>();
      for (const row of rows) groups.set(row.dataset.name, [...(groups.get(row.dataset.name) ?? []), row]);
      for (const [dataset, group] of groups) {
        try {
          const added = await client.add({ dataset, items: group.map((r) => ({ lunaId: r.id, text: `${memoryMarker(r.id)}\n${r.text}` })) });
          noteDataset(added.datasetId, added.datasetName);
          for (const [i, row] of group.entries()) await store.markAdded(row.id, { dataId: added.dataIds[i]!, datasetId: added.datasetId });
        } catch (error) {
          lastError = message(error);
          log({ event: "memory.add_failed", dataset, items: group.length, error: lastError });
        }
      }
    });
  }

  async function write(drafts: MemoryItemDraft[]): Promise<MemoryItem[]> {
    const result: MemoryItem[] = [];
    const created: string[] = [];
    for (const draft of drafts) {
      const text = draft.text.trim().slice(0, MEMORY_TEXT_MAX);
      if (text === "") throw new Error("a memory item needs text");
      const dataset = datasetFor(draft.repo, draft.source);
      const contentHash = md5(text);
      const existing = await store.findLive(dataset, contentHash);
      if (existing) {
        result.push(existing);
        continue;
      }
      const item: MemoryItem = {
        id: newId(draft.repo),
        kind: draft.kind,
        repo: draft.repo,
        source: draft.source,
        dataset: { name: dataset, id: null },
        cogneeDataId: null,
        anchors: draft.anchors,
        provenance: draft.provenance,
        trust: draft.trust,
        status: "pending",
        text,
        contentHash,
        createdAt: now().toISOString(),
      };
      await store.insert(item);
      created.push(item.id);
      result.push(item);
    }
    if (created.length > 0) await flush(created);
    const fresh = new Map((await store.getMany(result.map((r) => r.id))).map((r) => [r.id, r]));
    return result.map((r) => fresh.get(r.id) ?? r);
  }

  async function retryPending(): Promise<{ sent: number; pending: number }> {
    try {
      const rows = (await store.pending(RETRY_BATCH)).filter((r) => r.kind !== "doc" && r.kind !== "code");
      if (rows.length > 0) await flush(rows.map((r) => r.id));
      // A graph that was never built (its cognify failed, Cognee restarted) is built again here, each dataset at most every
      // COGNIFY_RETRY_MS after a failure, so one that keeps failing cannot hammer Cognee. The code graph has its own retry (the sync).
      const due = (await store.uncognifiedDatasets()).filter((name) => !name.startsWith("code:") && now().getTime() - (cognifyFailedAt.get(name) ?? 0) >= COGNIFY_RETRY_MS);
      if (due.length > 0) await cognify(due);
      const left = (await store.counts()).pending;
      return { sent: rows.length === 0 ? 0 : rows.length - (await store.getMany(rows.map((r) => r.id))).filter((r) => r.status === "pending").length, pending: left };
    } catch (error) {
      lastError = message(error);
      return { sent: 0, pending: 0 };
    }
  }

  /** When each dataset's cognify last failed (ms), for the retry's pause. */
  const cognifyFailedAt = new Map<string, number>();

  function cognify(datasets: string[]): Promise<void> {
    return cognifyExclusive(async () => {
      try {
        const names = [...new Set(datasets)];
        if (names.length === 0) return;
        const day = dayOf(now());
        if ((await store.cognifiedOn(day)) >= cap) {
          lastCognifyError = `the daily cap of ${cap} cognified items is reached; the graph waits until tomorrow`;
          log({ event: "memory.cognify_skipped", datasets: names, reason: "daily_cap", cap });
          return;
        }
        const items = await store.uncognified(names);
        if (items === 0) return;
        const started = Date.now();
        await client.cognify(names);
        await store.markCognified(names);
        await store.addCognified(day, items);
        lastCognifyError = null;
        usageCache = null;
        for (const name of names) cognifyFailedAt.delete(name);
        log({ event: "memory.cognify", datasets: names, items, durationMs: Date.now() - started });
      } catch (error) {
        lastCognifyError = message(error);
        for (const name of new Set(datasets)) cognifyFailedAt.set(name, now().getTime());
        log({ event: "memory.cognify_failed", datasets, error: lastCognifyError });
      }
    });
  }

  async function ingestDoc(doc: { repo: string | null; path: string; name: string; content: Buffer; anchors?: MemoryItem["anchors"] }): Promise<MemoryItem | null> {
    let rowId: string | null = null;
    try {
      const dataset = datasetFor(doc.repo, { kind: "doc", ref: doc.path });
      const hash = md5(doc.content);
      const live = await store.liveDocs(doc.repo, doc.path);
      const same = live.find((r) => r.contentHash === hash && r.status !== "pending");
      if (same) return same;
      const textual = mimeOf(doc.name) !== "application/octet-stream" && mimeOf(doc.name) !== "application/pdf";
      const item: MemoryItem = {
        id: newId(doc.repo),
        kind: "doc",
        repo: doc.repo,
        source: { kind: "doc", ref: doc.path.slice(0, 300) },
        dataset: { name: dataset, id: null },
        cogneeDataId: null,
        anchors: doc.anchors ?? { files: [doc.path], commit: null },
        provenance: { by: "machine", card: null, run: null, pack: null },
        trust: "fact",
        status: "pending",
        text: (textual ? `${doc.name}\n${doc.content.toString("utf8").slice(0, 300)}` : doc.name).slice(0, MEMORY_TEXT_MAX),
        contentHash: hash,
        createdAt: now().toISOString(),
      };
      await store.insert(item);
      rowId = item.id;
      const added = await exclusive(() => client.add({ dataset, items: [{ lunaId: item.id, file: { name: doc.name, content: doc.content, type: mimeOf(doc.name) } }] }));
      noteDataset(added.datasetId, added.datasetName);
      await store.markAdded(item.id, { dataId: added.dataIds[0]!, datasetId: added.datasetId });
      for (const old of live) await retireData(old, "replaced by a newer version of the document");
      return (await store.get(item.id)) ?? null;
    } catch (error) {
      lastError = message(error);
      log({ event: "memory.doc_failed", path: doc.path, error: lastError });
      // A document's bytes are not kept in the table, so a failed upload is not retried from a row: the trigger sends it again.
      if (rowId) await store.remove(rowId).catch(() => {});
      return null;
    }
  }

  async function removeDoc(doc: { repo: string | null; path: string }): Promise<void> {
    try {
      for (const row of await store.liveDocs(doc.repo, doc.path)) await retireData(row, "the document was deleted or moved");
    } catch (error) {
      lastError = message(error);
    }
  }

  async function ingestCode(code: { repo: string; dir: string; commit: string }): Promise<void> {
    let rowId: string | null = null;
    try {
      const dataset = datasetFor(code.repo, { kind: "code", ref: code.commit });
      const live = await store.liveCode(code.repo);
      let current = live.find((r) => r.anchors.commit === code.commit && r.status !== "pending") ?? null;
      if (!current) {
        const item: MemoryItem = {
          id: newId(code.repo),
          kind: "code",
          repo: code.repo,
          source: { kind: "code", ref: code.commit },
          dataset: { name: dataset, id: null },
          cogneeDataId: null,
          anchors: { files: [], commit: code.commit },
          provenance: { by: "machine", card: null, run: null, pack: null },
          trust: "fact",
          status: "pending",
          text: `The code graph of ${code.repo} at ${code.commit}`,
          contentHash: md5(`${code.repo}@${code.commit}`),
          createdAt: now().toISOString(),
        };
        await store.insert(item);
        rowId = item.id;
        // Cognee reads the copy from its own mount: `<state>/memory/code/<slug>/<commit>` is `/repos/<slug>/<commit>` in there.
        const added = await exclusive(() => client.add({ dataset, items: [{ lunaId: item.id, text: code.dir.startsWith(`${CODE_ROOT}/`) ? code.dir : `${CODE_ROOT}/${code.repo}/${code.commit}` }] }));
        noteDataset(added.datasetId, added.datasetName);
        await store.markAdded(item.id, { dataId: added.dataIds[0]!, datasetId: added.datasetId });
        // Cognee holds the repository now: a failed graph build below keeps the row, so reconcile knows the item and the next pass
        // builds again without adding it twice.
        rowId = null;
        current = await store.get(item.id);
      }
      await cognifyExclusive(async () => {
        const started = Date.now();
        await client.cognify([dataset]);
        await store.markCognified([dataset]);
        log({ event: "memory.code_graph", repo: code.repo, commit: code.commit, durationMs: Date.now() - started });
      });
      for (const old of live) if (old.id !== current?.id) await retireData(old, `superseded by the graph at ${code.commit}`);
    } catch (error) {
      lastError = message(error);
      log({ event: "memory.code_failed", repo: code.repo, commit: code.commit, error: lastError });
      if (rowId) await store.remove(rowId).catch(() => {});
      throw error;
    }
  }

  /** Code graph hits, as items a pack can read: the graph's own words, capped. */
  function codeItems(entries: Array<{ datasetName: string | null; error: string | null; results: unknown }>, repoOf: (dataset: string | null) => string): RecalledMemory[] {
    const out: RecalledMemory[] = [];
    for (const entry of entries) {
      if (entry.error || entry.results === null || entry.results === undefined) continue;
      const results = Array.isArray(entry.results) ? entry.results : [entry.results];
      for (const [i, result] of results.entries()) {
        const text = (typeof result === "string" ? result : JSON.stringify(result)).slice(0, DOC_CHUNK_MAX);
        const file = isRecord(result) ? (typeof result.file === "string" ? result.file : typeof result.path === "string" ? result.path : null) : null;
        out.push({ id: `code:${repoOf(entry.datasetName)}:${i}`, kind: "code", text, source: "code", anchors: { files: file ? [file] : [], commit: null }, stale: false, score: null });
      }
    }
    return out;
  }

  async function recall(query: RecallQuery): Promise<RecallResult> {
    const deadline = Date.now() + budget;
    const left = (): number => Math.max(100, deadline - Date.now());
    try {
      const scope = query.scope ?? "memory";
      const limit = Math.max(1, Math.min(query.limit ?? MEMORY_CONTEXT_MAX_ITEMS, MEMORY_CONTEXT_MAX_ITEMS));
      const text = query.query.trim();
      if (text === "") return { items: [], note: "no query" };
      const known = (await datasetList(left())).map((d) => d.name);
      const visible = datasetsFor(query.viewer, known).filter((name) => inScope(name, scope));
      if (visible.length === 0) return { items: [], note: "nothing recorded for this viewer yet" };

      const chunkSets = visible.filter((n) => !isCode(n));
      const codeSets = visible.filter(isCode);
      const [chunkEntries, codeEntries] = await Promise.all([
        chunkSets.length > 0 && scope !== "code" ? client.chunks({ datasets: chunkSets, query: text, topK: SEARCH_TOP_K, timeoutMs: left() }) : Promise.resolve([] as CogneeSearchEntry[]),
        codeSets.length > 0 && (scope === "code" || scope === "all") ? Promise.all(codeSets.map((dataset) => client.code({ dataset, operation: "search", args: { query: text }, timeoutMs: left() }))).then((r) => r.flat()) : Promise.resolve([]),
      ]);

      // Map each chunk back to its row: by the luna_id we added it with, the `luna:` line of its text, or its data item.
      const hits = chunkEntries.flatMap((e) => e.hits);
      const lunaOf = (h: (typeof hits)[number]): string | null => h.lunaId ?? lunaMarker(h.text);
      const rows = new Map((await store.getMany([...new Set(hits.map(lunaOf).filter((id): id is string => id !== null))])).map((r) => [r.id, r]));
      for (const hit of hits) {
        if (lunaOf(hit) === null && hit.dataId !== null) {
          const row = await store.byDataId(hit.dataId);
          if (row) rows.set(row.id, row);
        }
      }
      const allowed = new Set(visible);
      const best = new Map<string, { row: MemoryItem; score: number; chunk: string }>();
      for (const hit of hits) {
        const id = lunaOf(hit) ?? (hit.dataId ? [...rows.values()].find((r) => r.cogneeDataId === hit.dataId)?.id : undefined);
        const row = id ? rows.get(id) : undefined;
        if (!row || !allowed.has(row.dataset.name)) continue;
        if (row.status !== "active" && row.status !== "stale") continue;
        if (row.trust === "outside" && !query.includeOutside) continue;
        if (query.kinds && !query.kinds.includes(row.kind)) continue;
        if (!inScope(row.dataset.name, scope)) continue;
        const before = best.get(row.id);
        if (!before || hit.score > before.score) best.set(row.id, { row, score: hit.score, chunk: hit.text });
      }
      const ranked = [...best.values()].sort((a, b) => b.score - a.score);
      const items: RecalledMemory[] = [];
      let bytes = 0;
      let cut = false;
      const asItem = ({ row, score, chunk }: (typeof ranked)[number]): RecalledMemory => {
        // A document is many chunks: the matching one, without its marker line, says more than the row's preview.
        const body = row.kind === "doc" || row.kind === "code" ? chunk.replace(/^luna:\S+\s*/, "").slice(0, DOC_CHUNK_MAX) || row.text : row.text;
        return { id: row.id, kind: row.kind, text: body, source: row.source.kind, anchors: row.anchors, stale: row.status === "stale", score: Math.round(score * 1000) / 1000 };
      };
      const merged = [...ranked.map(asItem), ...codeItems(codeEntries, (d) => (d ?? "code:").slice("code:".length))];
      for (const item of merged) {
        if (items.length >= limit) {
          cut = true;
          break;
        }
        const size = Buffer.byteLength(item.text, "utf8");
        if (bytes + size > MEMORY_CONTEXT_MAX_BYTES) {
          cut = true;
          break;
        }
        bytes += size;
        items.push(item);
      }
      const failed = chunkEntries.filter((e) => e.error).length;
      const note = items.length === 0 ? (failed > 0 && failed === chunkEntries.length ? "no dataset of this viewer has a graph yet" : "nothing matched") : cut ? `cut to the cap (${items.length} of ${merged.length} matches)` : null;
      return { items, note };
    } catch (error) {
      const why = message(error);
      log({ event: "memory.recall_failed", error: why });
      return { items: [], note: `memory is unavailable: ${why}`.slice(0, 300) };
    }
  }

  async function code(query: { viewer: Parameters<Memory["code"]>[0]["viewer"]; repo: string; operation: CodeOperation; args: Record<string, unknown> }): Promise<unknown | null> {
    try {
      const dataset = datasetFor(query.repo, { kind: "code", ref: null });
      const known = (await datasetList(5000)).map((d) => d.name);
      if (!datasetsFor(query.viewer, known).includes(dataset)) return null;
      const entries = await client.code({ dataset, operation: query.operation, args: query.args, timeoutMs: 15_000 });
      const first = entries.find((e) => !e.error && e.results !== null);
      return first ? first.results : null;
    } catch (error) {
      lastError = message(error);
      return null;
    }
  }

  async function answer(query: { query: string; viewer: Parameters<Memory["answer"]>[0]["viewer"] }): Promise<MemoryAnswer | null> {
    if (options.mode === "local") return null;
    try {
      const known = (await datasetList(5000)).map((d) => d.name);
      const datasets = datasetsFor(query.viewer, known).filter((n) => !isCode(n));
      if (datasets.length === 0) return null;
      const text = await client.complete({ datasets, query: query.query });
      if (text === null) return null;
      // Cognee writes the answer; the sources are what recall finds for the same question, so each answer cites rows the viewer may see.
      const found = await recall({ query: query.query, viewer: query.viewer, scope: "all", limit: 6 });
      return { text, citations: found.items.map((i) => ({ kind: i.kind === "doc" ? ("doc" as const) : i.kind === "code" ? ("code" as const) : ("item" as const), ref: i.id })) };
    } catch (error) {
      lastError = message(error);
      log({ event: "memory.answer_failed", error: lastError });
      return null;
    }
  }

  async function forget(id: string, by: string, reason?: string): Promise<boolean> {
    const row = await store.get(id);
    if (!row) return false;
    if (row.status === "retired") return true;
    await retireData(row, `forgotten by ${by}${reason ? `: ${reason}` : ""}`.slice(0, 300));
    log({ event: "memory.forget", id, by });
    return true;
  }

  async function reconcile(): Promise<{ added: number; retired: number }> {
    let added = 0;
    let retired = 0;
    try {
      const datasets = await datasetList(10_000, true);
      for (const row of await store.pendingForgets(RETRY_BATCH)) {
        if (!row.cogneeDataId || !row.dataset.id) continue;
        try {
          await client.deleteData(row.dataset.id, row.cogneeDataId);
          await store.setStatus(row.id, "retired", "forgotten; its Cognee data is deleted", false);
        } catch (error) {
          lastError = message(error);
        }
      }
      for (const dataset of datasets) {
        let items;
        try {
          items = await client.data(dataset.id, 30_000);
        } catch (error) {
          lastError = message(error);
          continue;
        }
        const rows = await store.withData([dataset.name]);
        const seen = new Set(items.map((i) => i.id));
        const ours = new Set(rows.map((r) => r.cogneeDataId));
        for (const item of items) {
          if (ours.has(item.id) || (await store.byDataId(item.id))) continue;
          const mine = item.lunaId ? await store.get(item.lunaId) : null;
          if (mine) {
            // Cognee has the item, the row never heard back (the answer was lost): the row is in Cognee after all.
            if (mine.status === "pending") await store.markAdded(mine.id, { dataId: item.id, datasetId: dataset.id });
            continue;
          }
          const source = sourceOfDataset(dataset.name);
          await store.insert({
            id: newId(source.repo),
            kind: source.kind === "code" ? "code" : "doc",
            repo: source.repo,
            source: { kind: source.kind, ref: item.name.slice(0, 300) },
            dataset: { name: dataset.name, id: dataset.id },
            cogneeDataId: item.id,
            anchors: { files: [], commit: null },
            provenance: { by: "person", card: null, run: null, pack: null },
            trust: "outside",
            status: "active",
            text: `${item.name} (added outside Luna)`.slice(0, MEMORY_TEXT_MAX),
            contentHash: item.contentHash ?? md5(item.id),
            createdAt: now().toISOString(),
          });
          added++;
        }
        for (const row of rows) {
          if (row.cogneeDataId && !seen.has(row.cogneeDataId)) {
            await store.setStatus(row.id, "retired", "deleted outside Luna");
            retired++;
          }
        }
      }
      // An outside row for an item a row of ours now holds (an add that found the item already in Cognee, left by a build whose row was
      // lost): the item is Luna's, and forgetting the outside row would delete it, so the row is only retired.
      const held = await store.withData();
      const claimed = new Set(held.filter((r) => r.trust !== "outside" && r.status !== "retired").map((r) => r.cogneeDataId));
      for (const row of held) {
        if (row.trust === "outside" && row.status !== "retired" && claimed.has(row.cogneeDataId)) {
          await store.setStatus(row.id, "retired", "the item is Luna's own: a row of ours holds it");
          retired++;
        }
      }
      // A whole dataset removed in Cognee's UI takes its rows with it.
      const names = new Set(datasets.map((d) => d.name));
      for (const row of await store.withData()) {
        if (row.dataset.id !== null && !names.has(row.dataset.name)) {
          await store.setStatus(row.id, "retired", "deleted outside Luna");
          retired++;
        }
      }
      if (added > 0 || retired > 0) log({ event: "memory.reconcile", added, retired });
    } catch (error) {
      lastError = message(error);
      log({ event: "memory.reconcile_failed", error: lastError });
    }
    return { added, retired };
  }

  async function usage(): Promise<MemoryUsage | null> {
    try {
      const cognifiedToday = await store.cognifiedOn(dayOf(now()));
      if (options.mode === "local") return { tokensToday: null, costUsdToday: null, cognifiedToday };
      if (!usageCache || Date.now() - usageCache.at > USAGE_TTL_MS) {
        const found = usageOf(await client.cost("24h"));
        usageCache = { at: Date.now(), value: { tokensToday: found.tokens, costUsdToday: found.costUsd, cognifiedToday } };
      }
      return { ...usageCache.value, cognifiedToday };
    } catch (error) {
      lastError = message(error);
      return null;
    }
  }

  async function floor(): Promise<MemoryFloor> {
    const [used, counts] = await Promise.all([usage().catch(() => null), store.counts().catch(() => ({ pending: 0, active: 0 }))]);
    return {
      enabled: true,
      mode: options.mode,
      cognifiedToday: used?.cognifiedToday ?? 0,
      dailyCognifyItems: cap,
      tokensToday: used?.tokensToday ?? null,
      costUsdToday: used?.costUsdToday ?? null,
      pending: counts.pending,
      items: counts.active,
      note: lastCognifyError ?? (counts.pending > 0 ? lastError : null),
    };
  }

  return {
    enabled: true,
    mode: options.mode,
    write,
    cognify,
    ingestDoc,
    removeDoc,
    ingestCode,
    recall,
    code,
    answer,
    forget,
    async setStatus(id: string, status: MemoryStatus, note?: string): Promise<void> {
      await store.setStatus(id, status, note ?? null);
    },
    list: (filter: MemoryListFilter) => store.list(filter),
    get: (id: string) => store.get(id),
    adopt: (id: string, by: string) => store.adopt(id, by),
    reconcile,
    usage,
    retryPending,
    floor,
  };
}
