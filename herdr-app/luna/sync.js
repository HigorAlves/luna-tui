// Keeping the board's task list true while a snapshot and the stream race: pure, so `node --test`
// checks every rule.

/**
 * The snapshot `GET /tasks` answered, merged into what the stream already delivered. A task the
 * stream holds at a newer `seq` stays; a task the stream created after the snapshot was read
 * (a `seq` beyond every one in it) stays; a task the stream deleted since `since` stays gone.
 * `tombstones` is a Map of id to the time the stream deleted it.
 */
export function mergeSnapshot(current, snapshot, { tombstones = new Map(), since = 0 } = {}) {
  const have = new Map(current.map((t) => [t.id, t]));
  const top = Math.max(0, ...snapshot.map((t) => t.seq ?? 0));
  const out = [];
  const seen = new Set();
  for (const t of snapshot) {
    if ((tombstones.get(t.id) ?? -1) >= since) continue;
    const mine = have.get(t.id);
    out.push(mine && (mine.seq ?? 0) > (t.seq ?? 0) ? mine : t);
    seen.add(t.id);
  }
  for (const t of current) if (!seen.has(t.id) && (t.seq ?? 0) > top) out.push(t);
  return out;
}

/** How long a selection the stream has not delivered yet is kept. */
export const PENDING_MS = 15000;
