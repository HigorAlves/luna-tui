// An in-memory Memory for tests: the port's behaviour (ids, datasets, the visibility rule, statuses,
// the cap) with word-overlap scoring in place of Cognee's embeddings. Tests of callers use it; the
// Cognee adapter has its own contract tests.
import { createHash } from "node:crypto";

import { MEMORY_CONTEXT_MAX_ITEMS, type MemoryItem, type RecalledMemory } from "@hardness/contracts";

import type { Memory, MemoryItemDraft, MemoryListFilter, RecallQuery } from "../application/memory.ts";
import { datasetFor, datasetsFor } from "../domain/memory-datasets.ts";

const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

export interface FakeMemory extends Memory {
  readonly items: MemoryItem[];
  readonly cognified: string[][];
  readonly docs: Array<{ repo: string | null; path: string; name: string }>;
  readonly code_: Array<{ repo: string; dir: string; commit: string }>;
}

export function fakeMemory(options: { mode?: "openai" | "local"; now?: () => Date } = {}): FakeMemory {
  const items: MemoryItem[] = [];
  const cognified: string[][] = [];
  const docs: Array<{ repo: string | null; path: string; name: string }> = [];
  const code_: Array<{ repo: string; dir: string; commit: string }> = [];
  const now = options.now ?? (() => new Date("2026-11-06T22:00:00.000Z"));
  let next = 1;
  const make = (draft: MemoryItemDraft): MemoryItem => ({
    id: `mem_${String(next++).padStart(4, "0")}`,
    kind: draft.kind,
    repo: draft.repo,
    source: draft.source,
    dataset: { name: datasetFor(draft.repo, draft.source), id: null },
    cogneeDataId: null,
    anchors: draft.anchors,
    provenance: draft.provenance,
    trust: draft.trust,
    status: "active",
    text: draft.text.slice(0, 400),
    contentHash: createHash("md5").update(draft.text).digest("hex"),
    createdAt: now().toISOString(),
  });
  const matches = (item: MemoryItem, filter: MemoryListFilter): boolean =>
    (filter.repo === undefined || item.repo === filter.repo) &&
    (!filter.status || filter.status.includes(item.status)) &&
    (!filter.trust || filter.trust.includes(item.trust)) &&
    (!filter.kinds || filter.kinds.includes(item.kind)) &&
    (!filter.card || item.provenance.card === filter.card);
  const scopeOk = (item: MemoryItem, scope: RecallQuery["scope"]): boolean => {
    const s = scope ?? "memory";
    if (s === "all") return true;
    if (s === "code") return item.kind === "code";
    if (s === "docs") return item.kind === "doc";
    return item.kind !== "doc" && item.kind !== "code";
  };
  const memory: FakeMemory = {
    enabled: true,
    mode: options.mode ?? "openai",
    items,
    cognified,
    docs,
    code_,
    async write(drafts) {
      const rows = drafts.map(make);
      items.push(...rows);
      return rows;
    },
    async cognify(datasets) {
      cognified.push([...datasets]);
    },
    async ingestDoc(doc) {
      docs.push({ repo: doc.repo, path: doc.path, name: doc.name });
      for (const old of items) if (old.kind === "doc" && old.repo === doc.repo && old.source.ref === doc.path && old.status !== "retired") old.status = "retired";
      const [row] = await memory.write([{ kind: "doc", repo: doc.repo, source: { kind: "doc", ref: doc.path }, anchors: doc.anchors ?? { files: [doc.path], commit: null }, provenance: { by: "machine", card: null, run: null, pack: null }, trust: "fact", text: `${doc.name}\n${doc.content.toString("utf8").slice(0, 300)}` }]);
      return row ?? null;
    },
    async removeDoc(doc) {
      for (const old of items) if (old.kind === "doc" && old.repo === doc.repo && old.source.ref === doc.path) old.status = "retired";
    },
    async ingestCode(code) {
      code_.push(code);
    },
    async recall(query) {
      const known = [...new Set(items.map((i) => i.dataset.name))];
      const visible = new Set(datasetsFor(query.viewer, known));
      const q = words(query.query);
      const limit = Math.min(query.limit ?? MEMORY_CONTEXT_MAX_ITEMS, MEMORY_CONTEXT_MAX_ITEMS);
      const scored = items
        .filter((i) => visible.has(i.dataset.name) && (i.status === "active" || i.status === "stale") && (query.includeOutside || i.trust !== "outside") && scopeOk(i, query.scope) && (!query.kinds || query.kinds.includes(i.kind)))
        .map((i) => ({ i, score: [...words(i.text)].filter((w) => q.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const recalled: RecalledMemory[] = scored.map(({ i, score }) => ({ id: i.id, kind: i.kind, text: i.text, source: i.source.kind, anchors: i.anchors, stale: i.status === "stale", score }));
      return { items: recalled, note: recalled.length === 0 ? "nothing matched" : null };
    },
    async code(query) {
      return code_.some((c) => c.repo === query.repo) ? { operation: query.operation, hits: [] } : null;
    },
    async answer(query) {
      const r = await memory.recall({ query: query.query, viewer: query.viewer, scope: "all" });
      return { text: r.items.map((i) => i.text).join("\n"), citations: r.items.map((i) => ({ kind: "item" as const, ref: i.id })) };
    },
    async forget(id) {
      const item = items.find((i) => i.id === id);
      if (!item) return false;
      item.status = "retired";
      return true;
    },
    async setStatus(id, status) {
      const item = items.find((i) => i.id === id);
      if (item) item.status = status;
    },
    async list(filter) {
      const rows = items.filter((i) => matches(i, filter));
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? rows.length));
    },
    async get(id) {
      return items.find((i) => i.id === id) ?? null;
    },
    async adopt(id) {
      const item = items.find((i) => i.id === id && i.trust === "outside");
      if (!item) return false;
      item.trust = "lesson";
      return true;
    },
    async reconcile() {
      return { added: 0, retired: 0 };
    },
    async usage() {
      return { tokensToday: null, costUsdToday: null, cognifiedToday: cognified.flat().length };
    },
  };
  return memory;
}
