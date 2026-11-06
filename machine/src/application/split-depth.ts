// How deep a card sits in a chain of splits: 1, plus one for each card it was split from, up its chain (wave 15).
import { cardOf } from "../domain/card-fields.ts";

type Row = Parameters<typeof cardOf>[0];

/** At most this many hops are followed: a chain that long (or a loop) is as deep as any limit asks. */
const MAX_HOPS = 10;

/** `ticketHops` says how many tickets sit above the card's own ticket (a child ticket's card has no `splitFrom`): the depth is the deeper of the two chains. */
export async function splitDepth(get: (id: string) => Promise<Row | null>, row: Row, ticketHops?: (row: Row) => Promise<number>): Promise<number> {
  let depth = 1;
  let from = cardOf(row).splitFrom;
  while (from && depth <= MAX_HOPS) {
    depth += 1;
    const parent = await get(from);
    from = parent ? cardOf(parent).splitFrom : undefined;
  }
  const hops = ticketHops ? Math.max(0, Math.min(MAX_HOPS, await ticketHops(row).catch(() => 0))) : 0;
  return Math.max(depth, 1 + hops);
}
