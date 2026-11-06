// The memory port (RFC 0007): what the rest of the machine calls to remember and recall. The Cognee
// adapter (`adapters/cognee/`) and the `memory_items` table implement it; `noMemory()` answers
// nothing, so every caller works the same with memory off (no Cognee, `memory: off`, or a failure at
// boot). Callers never talk to Cognee and never choose datasets: they pass a viewer, and the
// implementation applies `datasetsFor` (domain/memory-datasets.ts).
import type { MemoryAnchors, MemoryItem, MemoryKind, MemorySourceKind, MemoryStatus, MemoryTrust, RecalledMemory } from "@hardness/contracts";

import type { MemoryViewer } from "../domain/memory-datasets.ts";

/** What a caller hands over to remember; the store gives it an id, a dataset, a hash and a status. */
export interface MemoryItemDraft {
  kind: MemoryKind;
  /** The repository's slug (`repoSlug()`), or null for a company document. */
  repo: string | null;
  source: { kind: MemorySourceKind; ref: string | null };
  anchors: MemoryAnchors;
  provenance: MemoryItem["provenance"];
  /** `fact` from the machine's records, `lesson` approved by a person. */
  trust: Exclude<MemoryTrust, "outside">;
  /** At most 400 characters, written by the machine's template or a pack. */
  text: string;
}

export type MemoryScope = "memory" | "docs" | "code" | "all";

export interface RecallQuery {
  query: string;
  viewer: MemoryViewer;
  kinds?: MemoryKind[];
  /** `memory`: card items; `docs`: the repo's docs and the company folder; `code`: the code graph; `all`: everything visible. Default `memory`. */
  scope?: MemoryScope;
  /** At most this many items back (default 12, never more than 12). */
  limit?: number;
  /** Include items with `trust: outside` (the board's memory view does; a pack never does). */
  includeOutside?: boolean;
}

export interface RecallResult {
  items: RecalledMemory[];
  /** Why the list is empty or short (Cognee down, nothing matched, cut to the cap); null when nothing to say. */
  note: string | null;
}

/** The code graph's read operations the machine allows (Cognee's `SearchType.CODE`). */
export const CODE_OPERATIONS = ["search", "ask", "neighbors", "find_path", "impact_analysis", "architecture", "flows", "query_facts"] as const;
export type CodeOperation = (typeof CODE_OPERATIONS)[number];

export interface MemoryAnswer {
  text: string;
  /** What the answer drew on: memory item ids, document names and pages, code symbols. */
  citations: Array<{ kind: "item" | "doc" | "code"; ref: string }>;
}

export interface MemoryUsage {
  /** Tokens Cognee's model calls spent today, when Cognee reports them. */
  tokensToday: number | null;
  costUsdToday: number | null;
  /** Items `cognify` processed today, counted by the machine (the daily cap's counter). */
  cognifiedToday: number;
}

export interface MemoryListFilter {
  repo?: string | null;
  status?: MemoryStatus[];
  trust?: MemoryTrust[];
  kinds?: MemoryKind[];
  card?: string;
  limit?: number;
  offset?: number;
}

export interface Memory {
  /** False for `noMemory()`: callers may skip work that only feeds memory. */
  readonly enabled: boolean;
  /** `openai`: Cognee extracts with its own key; `local`: no key, Cognee's local extractor; null when off. */
  readonly mode: "openai" | "local" | null;
  /** Records each item (status `pending`) and adds it to Cognee; a failed add stays `pending` and is retried. Returns the rows. */
  write(items: MemoryItemDraft[]): Promise<MemoryItem[]>;
  /** Asks Cognee to build the graph of these datasets, under the daily cap; never throws. */
  cognify(datasets: string[]): Promise<void>;
  /** Adds (or replaces, by path) one document of a repository's docs or the company folder. */
  ingestDoc(doc: { repo: string | null; path: string; name: string; content: Buffer; anchors?: MemoryAnchors }): Promise<MemoryItem | null>;
  /** Retires a document that was deleted or moved. */
  removeDoc(doc: { repo: string | null; path: string }): Promise<void>;
  /** Builds the code graph of `main` for a repository from a clean, writable copy (`dir`, a host path the Cognee service sees under its code root). */
  ingestCode(code: { repo: string; dir: string; commit: string }): Promise<void>;
  /** Items this viewer may see, best first, capped. Never throws: a failure is an empty list with a note. */
  recall(query: RecallQuery): Promise<RecallResult>;
  /** A code graph read, for the repository's viewers only. Null when memory is off or the repo has no code graph. */
  code(query: { viewer: MemoryViewer; repo: string; operation: CodeOperation; args: Record<string, unknown> }): Promise<unknown | null>;
  /** A written answer over what the viewer may see (Cognee's graph completion); null when memory is off or has no model. */
  answer(query: { query: string; viewer: MemoryViewer }): Promise<MemoryAnswer | null>;
  /** Forgets one item (deletes its Cognee data and retires the row); false when there is no such item. */
  forget(id: string, by: string, reason?: string): Promise<boolean>;
  /** Moves an item's status (stale by its anchors, retired by a revert or a contradiction). */
  setStatus(id: string, status: MemoryStatus, note?: string): Promise<void>;
  list(filter: MemoryListFilter): Promise<MemoryItem[]>;
  get(id: string): Promise<MemoryItem | null>;
  /** Marks a `trust: outside` item adopted by a person: it becomes a `lesson`. */
  adopt(id: string, by: string): Promise<boolean>;
  /** Lines Cognee's datasets up with the table: unknown data gets an `outside` row, missing data retires its row. */
  reconcile(): Promise<{ added: number; retired: number }>;
  usage(): Promise<MemoryUsage | null>;
}

/** Memory off: remembers nothing, recalls nothing, never throws. */
export function noMemory(): Memory {
  return {
    enabled: false,
    mode: null,
    write: async () => [],
    cognify: async () => {},
    ingestDoc: async () => null,
    removeDoc: async () => {},
    ingestCode: async () => {},
    recall: async () => ({ items: [], note: "memory is off" }),
    code: async () => null,
    answer: async () => null,
    forget: async () => false,
    setStatus: async () => {},
    list: async () => [],
    get: async () => null,
    adopt: async () => false,
    reconcile: async () => ({ added: 0, retired: 0 }),
    usage: async () => null,
  };
}
