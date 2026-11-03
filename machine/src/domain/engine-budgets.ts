// Monthly caps per engine or credential (MACHINE_ENGINE_BUDGETS on the machine, luna.yaml's
// `budget.engines` in one repo): which caps an engine falls under, what has been spent against
// each this calendar month, and whether one is reached. A reached cap holds the engine back like
// a missing credential (application/engine-gates.ts). Pure: the caller brings the spend.
import { type EngineBudgets, type EngineId, credentialOwner } from "@hardness/contracts";

export interface EngineCap {
  /** The engine (`openai:sol`) or credential (`openai`) the cap names. */
  key: string;
  limitUsd: number;
  /** This month's spend counted against it: the engine's own, or every engine on the credential. */
  spentUsd: number;
}

/** The first instant of the current calendar month, local time: where a month's spend starts. */
export const monthStart = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), 1);
/** `2026-10`, the month an alert key belongs to. */
export const monthKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

const usd = (value: number) => `$${value.toFixed(2)}`;

/** The caps `engine` falls under, its own first, each with the spend against it. */
export function capsOn(engine: EngineId, budgets: EngineBudgets, spend: ReadonlyMap<string, number>): EngineCap[] {
  const owner = credentialOwner(engine);
  const caps: EngineCap[] = [];
  if (budgets[engine] !== undefined) caps.push({ key: engine, limitUsd: budgets[engine], spentUsd: spend.get(engine) ?? 0 });
  if (budgets[owner] !== undefined) {
    const spentUsd = [...spend].filter(([id]) => credentialOwnerOf(id) === owner).reduce((sum, [, usd]) => sum + usd, 0);
    caps.push({ key: owner, limitUsd: budgets[owner], spentUsd });
  }
  return caps;
}

/** Spent at or past the cap. A zero cap trips only once something was spent: runs on the Codex
 *  login record no cost, so `codex=0` never holds Codex back. */
export function reached(spentUsd: number, limitUsd: number): boolean {
  return spentUsd >= limitUsd && (limitUsd > 0 || spentUsd > 0);
}

/** Why `engine` is held back by its caps (`over its monthly budget ($20.00 of $20.00 on openai)`), or null. */
export function overCap(engine: EngineId, budgets: EngineBudgets, spend: ReadonlyMap<string, number>, where = ""): string | null {
  const cap = capsOn(engine, budgets, spend).find((c) => reached(c.spentUsd, c.limitUsd));
  return cap ? `over its monthly budget (${usd(cap.spentUsd)} of ${usd(cap.limitUsd)} on ${cap.key}${where})` : null;
}

/** The credential an engine id in a spend row spends; null for a row from before engines or one no longer in the catalog. */
function credentialOwnerOf(id: string): string | null {
  try {
    return credentialOwner(id as EngineId);
  } catch {
    return null;
  }
}
