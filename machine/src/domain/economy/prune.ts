// Tool pruning (RFC 0007 §4): which tools and subagents a pack never reaches for in a repository. A run's allowed calls say which units it used;
// a unit that stays unused over enough runs and cards is proposed, a person approves the proposal into a mask, and one tap restores a unit for good.
// Pure: the state is a value, each step returns the next. Never tracked or proposed: reading, writing, shell commands and the luna tools the machine
// relies on (`PROTECTED_LUNA`), nor `delegate`, which is no unit of the pack's own. Nor skills: a pack's skills are preloaded into the agent's context, so no `Skill` call ever shows one used.
import { type EconomyConfig, PACKS, type Pack, type PackId, PROTECTED_LUNA, type ToolMask } from "@hardness/contracts";

/** What the evidence says of one unit in one pack of one repository. */
export interface UnitState {
  /** Runs that loaded the unit and did not use it, since the last use. */
  unusedRuns: number;
  /** The distinct cards of those runs, the latest kept. */
  unusedCards: string[];
  /** Used at least once, ever: the unit is never proposed. */
  everUsed: boolean;
  /** A person restored it after a mask: never proposed again. */
  kept: boolean;
}

export interface PackTools {
  units: Record<string, UnitState>;
  /** The units a person approved removing: the next run does not load them. */
  mask: string[];
  /** The units that earned a proposal and wait for a person. */
  proposal: string[];
}

export type PruneConfig = EconomyConfig["prune"];

/** Cards remembered per unit; the thresholds are far below it. */
const CARDS_KEPT = 20;
/** How the Claude runtime prefixes its luna tools. */
const LUNA_PREFIX = "mcp__luna__";

/** The luna tools some pack has that a mask may remove. */
const OPTIONAL_LUNA: ReadonlySet<string> = new Set(Object.values(PACKS).flatMap((p) => (p.kind === "agent" ? p.access.luna : [])).filter((tool) => !PROTECTED_LUNA.has(tool)));

const isSkill = (unit: string): boolean => unit.startsWith("skill:");

/** `state` without skill units, which an earlier version kept: skills are no unit now. */
export function withoutSkills(state: PackTools): PackTools {
  return { units: Object.fromEntries(Object.entries(state.units).filter(([unit]) => !isSkill(unit))), mask: state.mask.filter((u) => !isSkill(u)), proposal: state.proposal.filter((u) => !isSkill(u)) };
}

export const emptyTools = (): PackTools => ({ units: {}, mask: [], proposal: [] });

/** The units a pack has: `web`, `agent`, `luna:<tool>` per luna tool that is not protected. A pack without an agent has none. */
export function unitsOf(pack: Pack): string[] {
  if (pack.kind !== "agent") return [];
  const { access } = pack;
  return [
    ...(access.web ? ["web"] : []),
    ...(access.agent ? ["agent"] : []),
    ...access.luna.filter((tool) => !PROTECTED_LUNA.has(tool)).map((tool) => `luna:${tool}`),
  ];
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The units a run used, from its allowed tool calls (Claude's names and eve's alike); a refused call is not a use. */
export function usedUnits(events: unknown[]): Set<string> {
  const used = new Set<string>();
  for (const event of events) {
    const e = record(event);
    const call = e?.kind === "tool_call" ? record(e.payload) : null;
    if (!call || call.allowed !== true || typeof call.tool !== "string") continue;
    const tool = call.tool;
    if (tool === "WebFetch" || tool === "web_fetch") used.add("web");
    else if (tool === "Agent" || tool === "Task") used.add("agent");
    else if (tool.startsWith(LUNA_PREFIX)) used.add(`luna:${tool.slice(LUNA_PREFIX.length)}`);
    // eve names its luna tools bare: the same unit.
    else if (OPTIONAL_LUNA.has(tool)) used.add(`luna:${tool}`);
  }
  return used;
}

/** `state` after one run: `units` are the ones the run loaded (a masked unit was not, so the run says nothing of it), `used` the ones it used. The proposal is read again. */
export function foldTools(state: PackTools, run: { units: string[]; used: ReadonlySet<string>; cardId: string; prune: PruneConfig }): PackTools {
  const units = { ...state.units };
  for (const unit of run.units) {
    if (state.mask.includes(unit)) continue;
    const had = units[unit] ?? { unusedRuns: 0, unusedCards: [], everUsed: false, kept: false };
    units[unit] = run.used.has(unit)
      ? { ...had, everUsed: true, unusedRuns: 0, unusedCards: [] }
      : { ...had, unusedRuns: had.unusedRuns + 1, unusedCards: had.unusedCards.includes(run.cardId) ? had.unusedCards : [...had.unusedCards, run.cardId].slice(-CARDS_KEPT) };
  }
  const next = { ...state, units };
  return { ...next, proposal: proposalOf(next, run.prune) };
}

/** The units to propose: never used, not restored, not masked, and unused over `runs` runs on `min_cards` cards or over `cards` cards. */
export function proposalOf(state: PackTools, cfg: PruneConfig): string[] {
  return Object.entries(state.units)
    .filter(([unit, u]) => !u.everUsed && !u.kept && !state.mask.includes(unit) && ((u.unusedRuns >= cfg.runs && u.unusedCards.length >= cfg.min_cards) || u.unusedCards.length >= cfg.cards))
    .map(([unit]) => unit);
}

/** The proposal becomes the mask. */
export function approve(state: PackTools): PackTools {
  const clean = withoutSkills(state);
  return clean.proposal.length === 0 ? clean : { ...clean, mask: [...new Set([...clean.mask, ...clean.proposal])], proposal: [] };
}

/** `unit` is out of the mask and the proposal, and kept: it is never proposed again. */
export function restoreUnit(state: PackTools, unit: string): PackTools {
  const had = state.units[unit] ?? { unusedRuns: 0, unusedCards: [], everUsed: false, kept: false };
  return { units: { ...state.units, [unit]: { ...had, unusedRuns: 0, unusedCards: [], kept: true } }, mask: state.mask.filter((u) => u !== unit), proposal: state.proposal.filter((u) => u !== unit) };
}

/** The mask a runtime narrows the pack by. */
export function maskOf(state: Pick<PackTools, "mask">): ToolMask {
  const luna = state.mask.filter((u) => u.startsWith("luna:")).map((u) => u.slice("luna:".length));
  return {
    ...(state.mask.includes("web") ? { web: true } : {}),
    ...(state.mask.includes("agent") ? { agent: true } : {}),
    ...(luna.length > 0 ? { luna } : {}),
  };
}

export type { PackId };
