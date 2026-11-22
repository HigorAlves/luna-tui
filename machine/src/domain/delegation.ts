// Which slice the implementer may hand to the ui-designer, and which files each side then owns (RFC 0013, phase 5). Pure: no git, no I/O.
// The machine asks `delegable` when the implementer calls `slice_delegate`; the answer is the refusal's one line or the engine and the locks.
import { type EngineId, type Ledger, PACKS, type Slice, credentialOwner } from "@hardness/contracts";

import { looksLikeTestPath } from "./locked-files.ts";
import { touchesRenderedSurface } from "./rendered.ts";

/** A helper needs this many minutes, on the run's clock and on the design budget's, to be worth its own workspace and install. */
export const MIN_HELPER_MINUTES = 8;

/** What the implementer keeps of its own minutes while a helper runs: the helper's clock ends this much before the implementer's. */
export const IMPLEMENTER_RESERVE_MINUTES = 3;

/** The minutes a helper may run: the smaller of the design budget's and the implementer's, less what the implementer keeps. */
export const helperMinutes = (designMinutesLeft: number, implementerMinutesLeft: number): number => Math.min(designMinutesLeft, implementerMinutesLeft - IMPLEMENTER_RESERVE_MINUTES);

/** The files each side owns while a helper builds a slice: the implementer's are locked against the helper, the helper's against the implementer. */
export interface Locks {
  helper: string[];
  implementer: string[];
}

const MANIFEST = /(^|\/)(package\.json|pnpm-lock\.yaml|Cargo\.toml|go\.mod)$|\.lock$/;

/** A pure UI slice (D2): every planned file that is not a test renders, and none is a manifest or a lockfile. A dependency change is the implementer's. */
export function isUiSlice(touchpoints: readonly string[], webRoots: string[]): boolean {
  const sources = touchpoints.filter((file) => !looksLikeTestPath(file));
  return sources.length > 0 && sources.every((file) => !MANIFEST.test(file) && touchesRenderedSurface([file], webRoots));
}

const isOpen = (ledger: Ledger | undefined, id: number): boolean => ledger?.slices.find((s) => s.id === id)?.status !== "committed";

/** The locks for slice `sliceId` (1-based, as the ledger numbers it): the implementer's are the planned files of every other slice not yet committed. */
export function locksOf(slices: readonly Slice[], sliceId: number, ledger?: Ledger): Locks {
  const others = slices.flatMap((slice, i) => (i + 1 !== sliceId && isOpen(ledger, i + 1) ? slice.touchpoints : []));
  return { helper: [...(slices[sliceId - 1]?.touchpoints ?? [])], implementer: [...new Set(others)] };
}

export interface DelegationFacts {
  slices: Slice[];
  ledger: Ledger;
  sliceId: number;
  webRoots: string[];
  /** The card's design reference, or null when it has none (D9). */
  designRef: unknown | null;
  designOff: boolean;
  /** The helper running now on this card, if any: one at a time. */
  active: { slice: number } | null;
  /** The slices a helper has already had once. */
  attempted: ReadonlySet<number>;
  designBudget: { spent: boolean; minutesLeft: number };
  implementerMinutesLeft: number;
  implementerEngine: EngineId;
  /** The engine luna.yaml gives the ui_design pack, or null for its default. */
  repoEngine: EngineId | null;
  claudeAvailable: boolean;
}

export type Delegation = { ok: true; engine: EngineId; locks: Locks } | { ok: false; reason: string };

const no = (reason: string): Delegation => ({ ok: false, reason });

/** The engine of D6: the helper's own, unless both it and the implementer would hold the Codex login; then the first Claude engine it allows, or none. */
function helperEngine(f: DelegationFacts): EngineId | null {
  const pack = PACKS.ui_design.engines;
  const wanted = f.repoEngine ?? pack.default;
  if (credentialOwner(wanted) !== "codex" || credentialOwner(f.implementerEngine) !== "codex") return wanted;
  return f.claudeAvailable ? (pack.allowed.find((e) => credentialOwner(e) === "claude") ?? null) : null;
}

/** Whether slice `f.sliceId` may go to the ui-designer, with the first refusal's one line when not. */
export function delegable(f: DelegationFacts): Delegation {
  const id = f.sliceId;
  const slice = f.slices[id - 1];
  if (!slice) return no(`slice ${id} is not in the plan`);
  const entry = f.ledger.slices.find((s) => s.id === id);
  if (!entry) return no(`slice ${id} is not in the ledger`);
  if (entry.status !== "pending") return no(`slice ${id} is ${entry.status}, and only a pending slice can go to the ui-designer`);
  if (!isUiSlice(slice.touchpoints, f.webRoots)) return no(`slice ${id} is not a pure UI slice: a planned file does not render, or is a manifest or a test only; build it yourself`);
  for (const [i, other] of f.slices.entries()) {
    if (i + 1 === id || !isOpen(f.ledger, i + 1)) continue;
    const shared = slice.touchpoints.filter((file) => other.touchpoints.includes(file));
    if (shared.length > 0) return no(`slice ${id} shares ${shared.join(", ")} with slice ${i + 1}; build it yourself, or do the shared edit first`);
  }
  if (f.designRef === null || f.designRef === undefined) return no("the card has no design reference: build the slice yourself");
  if (f.designOff) return no("the designer agents are off for this card: build the slice yourself");
  if (f.active) return no(`the ui-designer is already building slice ${f.active.slice}; call slice_wait, then delegate again`);
  if (f.attempted.has(id)) return no(`the ui-designer already had slice ${id} once: build it yourself`);
  if (f.designBudget.spent) return no("the design budget is spent: build the slice yourself");
  if (f.designBudget.minutesLeft < MIN_HELPER_MINUTES) return no(`less than ${MIN_HELPER_MINUTES} minutes are left of the design budget: build the slice yourself`);
  if (helperMinutes(f.designBudget.minutesLeft, f.implementerMinutesLeft) < MIN_HELPER_MINUTES) return no(`less than ${MIN_HELPER_MINUTES} minutes would be left for the helper once the implementer keeps ${IMPLEMENTER_RESERVE_MINUTES} of this run's: build the slice yourself`);
  const engine = helperEngine(f);
  if (!engine) return no("the implementer and the ui-designer would both need the Codex login, and no Claude credential is set: build the slice yourself");
  return { ok: true, engine, locks: locksOf(f.slices, id, f.ledger) };
}
