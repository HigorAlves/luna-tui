import { sumTokens } from "@hardness/contracts";

import type { StageResult } from "../ports.ts";

type Usage = NonNullable<StageResult["usage"]>;

/** Two runs' usage added: turns and cost where either is known, tokens where either counted (every field, the cache writes too). */
export function addUsage(a: StageResult["usage"], b: StageResult["usage"]): StageResult["usage"] {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return { turns: sum(a.turns, b.turns), costUsd: sum(a.costUsd, b.costUsd), tokens: sumTokens(a.tokens, b.tokens) } satisfies Usage;
}
