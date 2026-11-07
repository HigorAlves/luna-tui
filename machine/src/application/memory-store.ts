// The port of the `memory_items` table (RFC 0007): the machine's record of what it sent to Cognee. The Postgres adapter is
// `adapters/persistence/memory-store.ts`. A row is a `MemoryItem` plus bookkeeping the contract does not carry.
import type { MemoryItem, MemoryStatus } from "@hardness/contracts";

import type { MemoryListFilter } from "./memory.ts";

export interface MemoryStore {
  insert(item: MemoryItem): Promise<void>;
  /** Drops a row that never reached Cognee and cannot be retried (a document upload that failed). */
  remove(id: string): Promise<void>;
  get(id: string): Promise<MemoryItem | null>;
  getMany(ids: readonly string[]): Promise<MemoryItem[]>;
  list(filter: MemoryListFilter): Promise<MemoryItem[]>;
  /** The live (pending, active or stale) row with this content in this dataset, if any. */
  findLive(dataset: string, contentHash: string): Promise<MemoryItem | null>;
  /** The rows of a document: every one at this repository and path that is not retired. */
  liveDocs(repo: string | null, path: string): Promise<MemoryItem[]>;
  /** The live code-graph rows of a repository. */
  liveCode(repo: string): Promise<MemoryItem[]>;
  byDataId(dataId: string): Promise<MemoryItem | null>;
  /** Pending rows, oldest first. */
  pending(limit: number): Promise<MemoryItem[]>;
  /** Rows a person forgot whose Cognee data is still there. */
  pendingForgets(limit: number): Promise<MemoryItem[]>;  /** The row is in Cognee: `active`, with its data and dataset ids. */
  markAdded(id: string, added: { dataId: string; datasetId: string }): Promise<void>;
  /** Moves a row's status with the reason; `forgetPending` marks a row a person forgot whose Cognee data is still there (`reconcile()` deletes it later). */
  setStatus(id: string, status: MemoryStatus, note: string | null, forgetPending?: boolean): Promise<void>;
  /** Moves an `outside` row to `lesson`, provenance `person`; false when it was not an outside row. */
  adopt(id: string, by: string): Promise<boolean>;
  /** Rows with Cognee data that are not retired, for `reconcile()`; `datasets` limits it to these dataset names. */
  withData(datasets?: readonly string[]): Promise<MemoryItem[]>;
  /** Live rows of these datasets Cognee has not built a graph for yet. */
  uncognified(datasets: readonly string[]): Promise<number>;
  /** The datasets holding items Cognee has but whose graph was never built (a cognify that failed or never ran). */
  uncognifiedDatasets(): Promise<string[]>;
  markCognified(datasets: readonly string[]): Promise<void>;
  cognifiedOn(day: string): Promise<number>;
  addCognified(day: string, items: number): Promise<void>;
  counts(): Promise<{ pending: number; active: number }>;
}

/** Rows with no Cognee data yet or no longer: what a `reconcile()` pass leaves alone. */
export const hasData = (item: MemoryItem): boolean => item.cogneeDataId !== null;
