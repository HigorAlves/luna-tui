// How deep a card sits in a chain of splits: 1, plus one for each card it was split from, up its chain (wave 15).
import { cardOf } from "../domain/card-fields.ts";

type Row = Parameters<typeof cardOf>[0];

/** At most this many hops are followed: a chain that long (or a loop) is as deep as any limit asks. */
const MAX_HOPS = 10;

export async function splitDepth(get: (id: string) => Promise<Row | null>, row: Row): Promise<number> {
  let depth = 1;
  let from = cardOf(row).splitFrom;
  while (from && depth <= MAX_HOPS) {
    depth += 1;
    const parent = await get(from);
    from = parent ? cardOf(parent).splitFrom : undefined;
  }
  return depth;
}
