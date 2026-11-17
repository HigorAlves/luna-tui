// Splits the rows of one projection into loads omnigraph accepts (RFC 0010, "What the spike found"):
// at most 8,192 entities per node type and per edge name in a load, and a body under the server's
// 32 MiB (24 MiB here, for margin). A node and the edges that start at it travel together, because
// the server refuses a load that leaves a node under an edge's minimum. A node loads after every
// node its edges point at, because the server also refuses an edge to a node it does not hold. Pure.
import { BRAIN_EDGES, BRAIN_NODE_TYPES, type BrainRow } from "@hardness/contracts";

export interface BrainBatchLimits {
  /** Entities of one node type, or of one edge name, in a load. */
  perKey: number;
  /** NDJSON bytes in a load. */
  bytes: number;
}

export const BRAIN_BATCH_LIMITS: BrainBatchLimits = { perKey: 8_192, bytes: 24 * 1024 * 1024 };

/** How late a node type loads: one step after the latest type an edge of its own points at. */
const LOAD_RANK: Record<string, number> = (() => {
  const rank: Record<string, number> = {};
  const rankOf = (type: string, path: readonly string[]): number => {
    if (rank[type] !== undefined) return rank[type];
    // An edge back to a type already on the path: the two cannot both go first, and no edge of today does this.
    if (path.includes(type)) return 0;
    const targets = Object.values(BRAIN_EDGES).filter((edge) => edge.from === type && edge.to !== type).map((edge) => edge.to);
    return (rank[type] = targets.length === 0 ? 0 : 1 + Math.max(...targets.map((target) => rankOf(target, [...path, type]))));
  };
  for (const type of BRAIN_NODE_TYPES) rankOf(type, []);
  return rank;
})();

/** Every node type, in the order a load needs: a type after every type its edges point at. A wipe goes the other way. */
export const BRAIN_LOAD_ORDER: readonly string[] = [...BRAIN_NODE_TYPES].sort((a, b) => LOAD_RANK[a]! - LOAD_RANK[b]!);

interface Unit {
  /** Where the unit loads: its node type's rank; an edge with no node of its own goes last. */
  rank: number;
  rows: BrainRow[];
  counts: Map<string, number>;
  bytes: number;
}

const keyOf = (row: BrainRow): string => ("type" in row ? row.type : row.edge);
const sizeOf = (row: BrainRow): number => Buffer.byteLength(`${JSON.stringify(row)}\n`);

function unitOf(rows: BrainRow[], limits: BrainBatchLimits): Unit {
  const head = rows[0]!;
  const rank = "type" in head ? (LOAD_RANK[head.type] ?? 0) : Number.MAX_SAFE_INTEGER;
  const counts = new Map<string, number>();
  let bytes = 0;
  for (const row of rows) {
    counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
    bytes += sizeOf(row);
  }
  if (bytes > limits.bytes || [...counts.values()].some((count) => count > limits.perKey)) {
    const first = rows[0]!;
    throw new Error(`brain batch: ${"type" in first ? String(first.data.slug) : `${first.edge} ${first.from}`} with its edges is too large for one load`);
  }
  return { rank, rows, counts, bytes };
}

/** The loads for `rows`: node types in the order their edges need, and the caller's order within a type. Throws when one node with its edges cannot fit a load. */
export function brainBatches(rows: BrainRow[], limits: Partial<BrainBatchLimits> = {}): BrainRow[][] {
  const max: BrainBatchLimits = { ...BRAIN_BATCH_LIMITS, ...limits };
  const nodeSlugs = new Set(rows.flatMap((row) => ("type" in row ? [String(row.data.slug)] : [])));
  const edgesOf = new Map<string, BrainRow[]>();
  for (const row of rows) {
    if ("edge" in row && nodeSlugs.has(row.from)) edgesOf.set(row.from, [...(edgesOf.get(row.from) ?? []), row]);
  }

  const units: Unit[] = [];
  for (const row of rows) {
    if ("type" in row) units.push(unitOf([row, ...(edgesOf.get(String(row.data.slug)) ?? [])], max));
    else if (!nodeSlugs.has(row.from)) units.push(unitOf([row], max));
  }

  // The sort is stable, so rows of one type keep the caller's order.
  units.sort((a, b) => a.rank - b.rank);

  const batches: BrainRow[][] = [];
  let current: BrainRow[] = [];
  let counts = new Map<string, number>();
  let bytes = 0;
  for (const unit of units) {
    const fits = bytes + unit.bytes <= max.bytes && [...unit.counts].every(([key, count]) => (counts.get(key) ?? 0) + count <= max.perKey);
    if (!fits) {
      batches.push(current);
      current = [];
      counts = new Map();
      bytes = 0;
    }
    current.push(...unit.rows);
    bytes += unit.bytes;
    for (const [key, count] of unit.counts) counts.set(key, (counts.get(key) ?? 0) + count);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
