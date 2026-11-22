// The coordinator of the ui-designer helper for one implementing run (RFC 0013, phase 5). The implementer asks for a helper through the checks mailbox
// (`slice_delegate`); the build watch hands each request here. The machine checks it with the pure `delegable` rule, makes the helper's own workspace at the
// card's tip, starts the `ui_design` pack there as a sub-run in the background, and answers at once. When the helper ends the machine takes its commits into
// the card's repository (never the container's `.git`), and the state file `helper-state-<slice>.json` tells the implementer's factory where things stand.
// The machine never reads that file back (the container can overwrite it): the state lives here, in memory.
//
// Everything comes through `deps`: no Docker, no Postgres. Slice 78 adds the pick (`onPickRequest`, `onPickAck`, the re-run, `merge_conflict`) to the same
// state: a helper that is `returned` holds the tip and the commits it will pick.
import { type EngineId, Ledger, type StageInput, oneLine } from "@hardness/contracts";

import { readRegularFile } from "../../adapters/fs/bounded.ts";
import type { ImportResult } from "../../adapters/git/bundles.ts";
import type { helperWorkspace, takeHelperCommits } from "../../adapters/git/helper.ts";
import { type DelegationFacts, type Locks, delegable, helperMinutes } from "../../domain/delegation.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { type HelperEventKind, type HelperPayloads, helperEnded } from "../../domain/helper-events.ts";
import type { StageOutcome } from "../../domain/transition.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type HelperAnswer, type HelperCoordinator, type HelperRequest, type PickAck, type PickAnswer, type PickDone, type PickRequest, writeMailbox } from "./build-watch.ts";

/** Where a helper stands, as the implementer's factory reads it from `helper-state-<slice>.json`. */
export type HelperState = "running" | "returned" | "picking" | "conflict_rerun" | "committed" | "refused" | "failed" | "cancelled" | "merge_conflict";

/** The states in which the helper still holds its slice and its files. */
const LIVE: ReadonlySet<HelperState> = new Set(["running", "returned", "picking", "conflict_rerun"]);

const LEDGER_CAP = 4 * 1024 * 1024;
const SUMMARY_CAP = 300;
const CANCEL_WAIT_MS = 30_000;

/** What the pack runner's helper run takes besides the context (slice 79): its own workspace and what it builds. */
export interface HelperRunExtra {
  workspace: { path: string; branch: string };
  helper: NonNullable<StageInput["context"]["helper"]>;
}

/** What the machine knows when the implementer asks, read fresh each time: the plan, the card's design, the budgets, the engines. */
export type HelperFacts = Pick<DelegationFacts, "slices" | "webRoots" | "designRef" | "designOff" | "designBudget" | "implementerMinutesLeft" | "implementerEngine" | "repoEngine" | "claudeAvailable">;

export interface HelperRunsDeps {
  taskId: string;
  /** The card's workspace `W`. */
  cardPath: string;
  /** The implementer's `/out` folder on the host: `ledger.json` is read from it and the mailbox written in it. */
  outDir: string;
  /** The implementer's stage context: the helper's is made from it. */
  context: StageContext;
  /** The implementer's own signal: an abort of the run aborts the helper. */
  signal: AbortSignal;
  /** The run's bundle importer: the card's tip is what it has imported. */
  importer: { sync(): Promise<ImportResult> };
  facts(): Promise<HelperFacts>;
  helperWorkspace: Pick<typeof helperWorkspace, "make" | "remove">;
  takeHelperCommits: typeof takeHelperCommits;
  /** The helper's own run in the pack runner (slice 79). */
  runHelper(context: StageContext, extra: HelperRunExtra): Promise<StageResult>;
  emit: NonNullable<StageContext["emit"]>;
  /** The shas the machine picked onto this card's branch on earlier runs (its own `build.helper_picked` rows). */
  priorPicked?: Iterable<string>;
  now?: () => number;
  /** How long `cancel` waits for the helper to settle; 30 s by default. */
  cancelWaitMs?: number;
  log?: (line: string) => void;
}

/** What the end of the run decides over whatever the agent answered (D8, slice 81): the pack runner turns it into an escalation with this reason. */
export interface HelperEscalation {
  escalate: "merge_conflict" | "design_budget";
  reason: string;
}

export interface HelperRuns extends HelperCoordinator {
  /** The run ended with `outcome`: a helper still out is cancelled (slice 78 lands it first after a pass). Returns the escalation the machine's facts decide, if any. */
  afterRun(outcome: StageOutcome): Promise<HelperEscalation | null>;
  /** Aborts the helper, waits for it (at most `cancelWaitMs`), records `cancelled` and removes its workspace. */
  cancel(): Promise<void>;
  /** The shas the machine picked onto the card's branch: earlier runs' and this one's. Read when asked. */
  picked(): ReadonlySet<string>;
  /** The files the helper holds while it has its slice: the implementer must not touch them. */
  delegatedLocks(): string[];
}

interface Helper {
  slice: number;
  attempt: number;
  base: string;
  ref: string;
  workspace: string;
  locks: Locks;
  state: HelperState;
  controller: AbortController;
  settled: Promise<void>;
  removed: boolean;
  /** Once `returned`: the helper ref's tip and the commits (oldest first) the pick will take. */
  tip?: string;
  commits?: string[];
}

/** A line of a model's or container's text, for the state file: one line, cleaned, capped. */
const line = (text: unknown): string => safe(oneLine(typeof text === "string" ? text : "", SUMMARY_CAP)).slice(0, SUMMARY_CAP);

const reasonOf = (result: StageResult): string => {
  const d = result.detail ?? {};
  return line(d.error) || line(d.reason) || line(d.summary) || `the run ended ${result.outcome}`;
};

async function readLedger(outDir: string): Promise<Ledger | null> {
  try {
    return Ledger.parse(JSON.parse(await readRegularFile(`${outDir}/ledger.json`, LEDGER_CAP)));
  } catch {
    return null;
  }
}

export function helperRuns(deps: HelperRunsDeps): HelperRuns {
  const now = deps.now ?? Date.now;
  const helpers = new Map<number, Helper>();
  const attempted = new Set<number>();
  const pickedShas = new Set<string>(deps.priorPicked ?? []);
  let escalation: HelperEscalation | null = null;

  const row = async <K extends HelperEventKind>(kind: K, payload: HelperPayloads[K]): Promise<void> => {
    await Promise.resolve(deps.emit(kind, { ...payload })).catch(() => {});
  };

  const setState = async (h: Helper, state: HelperState, summary?: string): Promise<void> => {
    h.state = state;
    const file = JSON.stringify({ state, attempt: h.attempt, ...(summary ? { summary } : {}) });
    await writeMailbox(deps.outDir, `helper-state-${h.slice}.json`, file).catch((error) => deps.log?.(`helper state not written: ${error instanceof Error ? error.message : String(error)}`));
  };

  /** The helper's workspace is removed once, whatever ended it. */
  const release = async (h: Helper): Promise<void> => {
    if (h.removed) return;
    h.removed = true;
    await deps.helperWorkspace.remove(h.workspace).catch((error) => deps.log?.(`helper workspace not removed: ${error instanceof Error ? error.message : String(error)}`));
  };

  const active = (): Helper | undefined => [...helpers.values()].find((h) => LIVE.has(h.state));

  /** The helper's run has ended: log it, then follow where it goes. */
  async function settle(h: Helper, result: StageResult, minutes: number): Promise<void> {
    await row("build.helper_ended", helperEnded(h.slice, h.attempt, result, minutes));
    // The helper's own spending can spend the design budget: the run ends in `design_budget`, whatever the agent answers.
    const budget = await deps.facts().then((f) => f.designBudget.spent).catch(() => false);
    if (budget && !escalation) escalation = { escalate: "design_budget", reason: `the design budget is spent: the ui-designer's run on slice ${h.slice} used the last of it; a person decides` };
    // A cancel that gave up waiting has recorded `cancelled` already; a late end changes nothing but the row above.
    if (!LIVE.has(h.state)) return;
    if (h.controller.signal.aborted) {
      await setState(h, "cancelled");
      await release(h);
      return;
    }
    if (result.outcome !== "pass") {
      await setState(h, "failed", reasonOf(result));
      await release(h);
      return;
    }
    const taken = await deps.takeHelperCommits(deps.cardPath, h.workspace, deps.taskId, h.slice, h.base, { locked: h.locks.implementer }).catch((error): { ok: false; reason: "fetch_failed"; detail: string } => ({ ok: false, reason: "fetch_failed", detail: error instanceof Error ? error.message : String(error) }));
    if (taken.ok) {
      h.tip = taken.tip;
      h.commits = taken.commits;
      await setState(h, "returned");
      return;
    }
    // D4: a helper that still touched the implementer's files is refused, and the slice goes back to the implementer.
    if (taken.reason === "locked_file") {
      const reason = line(`the ui-designer touched files the implementer holds: ${(taken.files ?? [taken.detail]).join(", ")}; the slice is yours`);
      await row("build.helper_refused", { slice: h.slice, reason });
      await setState(h, "refused", reason);
    } else {
      await setState(h, "failed", line(`the ui-designer's commits could not be taken in: ${taken.detail}`));
    }
    await release(h);
  }

  /** Starts the helper's run in the background; nothing waits for it here. */
  function launch(h: Helper, extra: HelperRunExtra, context: StageContext): void {
    const t0 = now();
    h.settled = (async () => {
      let result: StageResult;
      try {
        result = await deps.runHelper(context, extra);
      } catch (error) {
        result = { outcome: "fail", detail: { error: error instanceof Error ? error.message : String(error) } };
      }
      await settle(h, result, (now() - t0) / 60_000).catch((error) => deps.log?.(`helper not settled: ${error instanceof Error ? error.message : String(error)}`));
    })();
  }

  async function onHelperRequest(request: HelperRequest): Promise<HelperAnswer> {
    const slice = request.slice;
    if (!Number.isInteger(slice) || slice < 1) return { ok: false, error: `${JSON.stringify(slice)} is not a slice number` };
    const refuse = async (reason: string): Promise<HelperAnswer> => {
      const said = line(reason);
      await row("build.helper_refused", { slice, reason: said });
      return { ok: false, error: reason };
    };
    const synced = await deps.importer.sync();
    if (!synced.ok) return refuse(`your commits could not be taken in yet (${synced.reason}); call slice_list, then delegate again`);
    const base = synced.head;
    const ledger = await readLedger(deps.outDir);
    if (!ledger) return refuse("the slice ledger could not be read; build the slice yourself");
    const facts = await deps.facts();
    const current = active();
    const decision = delegable({ ...facts, ledger, sliceId: slice, active: current ? { slice: current.slice } : null, attempted });
    if (!decision.ok) return refuse(decision.reason);
    const planned = facts.slices[slice - 1]!;
    const attempt = 1;
    let workspace: Awaited<ReturnType<HelperRunsDeps["helperWorkspace"]["make"]>>;
    try {
      workspace = await deps.helperWorkspace.make(deps.cardPath, base, deps.taskId, slice, attempt);
    } catch (error) {
      return refuse(`the helper's workspace could not be made: ${error instanceof Error ? error.message : String(error)}`);
    }
    const controller = new AbortController();
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const h: Helper = { slice, attempt, base, ref: workspace.ref, workspace: workspace.path, locks: decision.locks, state: "running", controller, settled: Promise.resolve(), removed: false };
    helpers.set(slice, h);
    attempted.add(slice);
    await setState(h, "running");
    await row("build.helper_started", { slice, base, branch: workspace.ref, engine: decision.engine, attempt, locks: decision.locks });
    const context: StageContext = {
      ...deps.context,
      runId: `${deps.context.runId}-helper-${slice}-${attempt}`,
      started: undefined,
      resume: undefined,
      engine: decision.engine as EngineId,
      budgetMinutes: helperMinutes(facts.designBudget.minutesLeft, facts.implementerMinutesLeft),
      signal: controller.signal,
    };
    const extra: HelperRunExtra = {
      workspace: { path: workspace.path, branch: workspace.branch },
      helper: {
        slice: { id: slice, title: planned.title, touchpoints: planned.touchpoints, acceptance: planned.acceptance },
        message: request.message.slice(0, 2000),
        base,
        locks: { mine: decision.locks.helper, theirs: decision.locks.implementer },
        attempt,
      },
    };
    launch(h, extra, context);
    return { ok: true, handle: `${deps.taskId}/${slice}`, branch: workspace.ref, base, locks: decision.locks.helper };
  }

  async function cancel(): Promise<void> {
    const out = [...helpers.values()].filter((h) => LIVE.has(h.state));
    for (const h of out) h.controller.abort();
    await Promise.all(
      out.map(async (h) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([h.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, deps.cancelWaitMs ?? CANCEL_WAIT_MS)))]);
        clearTimeout(timer);
        if (LIVE.has(h.state)) await setState(h, "cancelled");
        await release(h);
      }),
    );
  }

  return {
    onHelperRequest,
    // Slice 78: the pick handshake. Until then the factory is told no, in the plain words its tools already handle.
    onPickRequest: async (_request: PickRequest): Promise<PickAnswer> => ({ ok: false, error: "not yet: the pick is not built" }),
    onPickAck: async (_request: PickAck): Promise<PickDone> => ({ ok: false, reason: "not yet: the pick is not built" }),
    async afterRun(outcome) {
      // Slice 78: after a pass, wait for a running helper and land it. For now whatever is still out is cancelled.
      void outcome;
      await cancel();
      return escalation;
    },
    cancel,
    picked: () => pickedShas,
    delegatedLocks: () => [...new Set([...helpers.values()].filter((h) => LIVE.has(h.state)).flatMap((h) => h.locks.helper))],
  };
}
