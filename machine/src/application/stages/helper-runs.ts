// The coordinator of the ui-designer helper for one implementing run (RFC 0013, phase 5). The implementer asks for a helper through the checks mailbox
// (`slice_delegate`); the build watch hands each request here. The machine checks it with the pure `delegable` rule, makes the helper's own workspace at the
// card's tip, starts the `ui_design` pack there as a sub-run in the background, and answers at once. When the helper ends the machine takes its commits into
// the card's repository (never the container's `.git`), and the state file `helper-state-<slice>.json` tells the implementer's factory where things stand.
// The machine never reads that file back (the container can overwrite it): the state lives here, in memory.
//
// Everything comes through `deps`: no Docker, no Postgres. The pick handshake (`onPickRequest`, `onPickAck`), the one re-run and `merge_conflict` live in the
// same state: a helper that is `returned` holds the tip and the commits it will pick; `picking` holds the pending `{ P, tip, picked }` too. The three mailbox
// queues run concurrently, so every step that reads or moves the card's branch goes through `serial`.
import type { AgentExtra } from "./pack-runner.ts";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type EngineId, Ledger, type StageInput, oneLine } from "@hardness/contracts";

import { readRegularFile } from "../../adapters/fs/bounded.ts";
import type { ImportResult } from "../../adapters/git/bundles.ts";
import { type advanceBranch, type helperWorkspace, type landInWorktree, type pickBundle, type pickOnto, pickedRef, type takeHelperCommits } from "../../adapters/git/helper.ts";
import { type DelegationFacts, type Locks, MIN_HELPER_MINUTES, delegable, helperMinutes } from "../../domain/delegation.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { type HelperEventKind, type HelperPayloads, helperEnded } from "../../domain/helper-events.ts";
import type { StageOutcome } from "../../domain/transition.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type HelperAnswer, type HelperCoordinator, type HelperRequest, type PickAck, type PickAnswer, type PickDone, type PickRequest, writeMailbox, writeMailboxFile } from "./build-watch.ts";

/** Where a helper stands, as the implementer's factory reads it from `helper-state-<slice>.json`. */
export type HelperState = "running" | "returned" | "picking" | "conflict_rerun" | "committed" | "refused" | "failed" | "cancelled" | "merge_conflict";

/** The states in which the helper still holds its slice and its files. */
const LIVE: ReadonlySet<HelperState> = new Set(["running", "returned", "picking", "conflict_rerun"]);

const LEDGER_CAP = 4 * 1024 * 1024;
const SUMMARY_CAP = 300;
const CANCEL_WAIT_MS = 30_000;

/** What the pack runner's helper run takes besides the context (slice 79): its own workspace and what it builds. */
export interface HelperRunExtra extends Pick<AgentExtra, "design" | "scenarioTests" | "testsFiles" | "inlineTests"> {
  workspace: { path: string; branch: string };
  helper: NonNullable<StageInput["context"]["helper"]>;
}

/** What the machine knows when the implementer asks, read fresh each time: the plan, the card's design, the budgets, the engines. */
export type HelperFacts = Pick<DelegationFacts, "slices" | "webRoots" | "designRef" | "designOff" | "designBudget" | "implementerMinutesLeft" | "implementerEngine" | "repoEngine" | "claudeAvailable"> & {
  /** Every path of the card's tests commit: the helper may not change one (slice 80 reads them from the run's `testsFiles`). */
  protectedPaths?: readonly string[];
};

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
  /** The card's branch (`workspace.branch`): only the machine moves it, by compare-and-swap. */
  branch: string;
  /** The machine's committer identity on the picked commits. */
  identity: { name: string; email: string };
  /** The card's repository work, on the card's workspace `W`. */
  git: {
    pickOnto: typeof pickOnto;
    pickBundle: typeof pickBundle;
    advanceBranch: typeof advanceBranch;
    landInWorktree: typeof landInWorktree;
  };
  /** Shows the card's branch in the user's repository after the machine moved it (the pack runner's `publishBranch`); a refusal is a note. */
  publish?: () => Promise<{ ok: true } | { ok: false; note: string }>;
  note?: (text: string) => Promise<void>;
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
  /** The run ended with `outcome`. After a pass a live helper is waited for (within its limit), picked onto the card's tip and landed in `W`; after anything else it is cancelled. Returns the escalation the machine's facts decide, if any. */
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
  attempt: 1 | 2;
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
  /** The pick the factory was told about, until its ack: the card's tip `P` it was made onto, the picked tip and every sha made. */
  pending?: { P: string; tip: string; picked: string[] };
  /** When the helper's own limit ends (ms on `now`). */
  deadline: number;
  engine: string;
  /** The helper's branch in its own workspace. */
  branch: string;
  planned: { title: string; touchpoints: string[]; acceptance: string[] };
  message: string;
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

  /** An abort controller that follows the implementer's own signal. */
  const linkedController = (): AbortController => {
    const controller = new AbortController();
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener("abort", () => controller.abort(), { once: true });
    return controller;
  };

  /** The helper's own stage context for its current attempt. */
  const contextOf = (h: Helper, minutes: number): StageContext => ({
    ...deps.context,
    runId: `${deps.context.runId}-helper-${h.slice}-${h.attempt}`,
    started: undefined,
    resume: undefined,
    engine: h.engine as EngineId,
    budgetMinutes: minutes,
    signal: h.controller.signal,
  });

  const runOf = (h: Helper, conflict?: { files: string[] }): HelperRunExtra => ({
    workspace: { path: h.workspace, branch: h.branch },
    helper: {
      slice: { id: h.slice, title: h.planned.title, touchpoints: h.planned.touchpoints, acceptance: h.planned.acceptance },
      message: h.message,
      base: h.base,
      locks: { mine: h.locks.helper, theirs: h.locks.implementer },
      attempt: h.attempt,
      ...(conflict ? { conflict } : {}),
    },
  });

  /** One operation at a time on the card's branch: the three mailbox queues run concurrently. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
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
    const protectedPaths = await deps.facts().then((f) => f.protectedPaths ?? []).catch(() => []);
    const taken = await deps.takeHelperCommits(deps.cardPath, h.workspace, deps.taskId, h.slice, h.base, { locked: h.locks.implementer, allowed: h.locks.helper, protectedPaths }).catch((error): { ok: false; reason: "fetch_failed"; detail: string } => ({ ok: false, reason: "fetch_failed", detail: error instanceof Error ? error.message : String(error) }));
    if (taken.ok && taken.commits.length === 0) {
      await setState(h, "failed", "the ui-designer made no commits; build the slice yourself");
      await release(h);
      return;
    }
    if (taken.ok) {
      h.tip = taken.tip;
      h.commits = taken.commits;
      await setState(h, "returned");
      return;
    }
    // D4: a helper that still touched the implementer's files is refused, and the slice goes back to the implementer.
    if (taken.reason === "locked_file" || taken.reason === "out_of_slice") {
      const reason = line(taken.reason === "locked_file" ? `the ui-designer touched files the implementer holds: ${(taken.files ?? [taken.detail]).join(", ")}; the slice is yours` : `the ui-designer touched files outside its slice: ${(taken.files ?? [taken.detail]).join(", ")}; the slice is yours`);
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
    const minutes = helperMinutes(facts.designBudget.minutesLeft, facts.implementerMinutesLeft);
    const h: Helper = { slice, attempt, base, ref: workspace.ref, workspace: workspace.path, locks: decision.locks, state: "running", controller: linkedController(), settled: Promise.resolve(), removed: false, deadline: now() + minutes * 60_000, engine: decision.engine, branch: workspace.branch, planned: { title: planned.title, touchpoints: planned.touchpoints, acceptance: planned.acceptance }, message: request.message.slice(0, 2000) };
    helpers.set(slice, h);
    attempted.add(slice);
    await setState(h, "running");
    await row("build.helper_started", { slice, base, branch: workspace.ref, engine: decision.engine, attempt, locks: decision.locks });
    launch(h, runOf(h), contextOf(h, minutes));
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

  const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const filesOf = (files: string[]): string => files.slice(0, 20).join(", ") || "files the machine could not name";

  /** The helper's commits go wrong for good: the slice goes back to the implementer. */
  async function fail(h: Helper, reason: string): Promise<void> {
    await setState(h, "failed", line(reason));
    h.pending = undefined;
    await release(h);
  }

  /** A second conflict (or one with no time left to re-run): the run ends in `merge_conflict` whatever the agent answers (D8). */
  async function mergeConflict(h: Helper, files: string[]): Promise<string> {
    const reason = line(`the ui-designer's commits for slice ${h.slice} conflict with yours in ${filesOf(files)}; a person merges them`);
    await row("build.helper_conflict", { slice: h.slice, attempt: h.attempt, files });
    escalation ??= { escalate: "merge_conflict", reason };
    h.pending = undefined;
    await setState(h, "merge_conflict", reason);
    await release(h);
    return reason;
  }

  /** The first conflict: one re-run on a new workspace at the card's tip `P`, told which files conflicted. Returns the words for the factory. */
  async function rerun(h: Helper, P: string, files: string[]): Promise<string> {
    await row("build.helper_conflict", { slice: h.slice, attempt: h.attempt, files });
    h.pending = undefined;
    await release(h);
    const facts = await deps.facts();
    const minutes = helperMinutes(facts.designBudget.minutesLeft, facts.implementerMinutesLeft);
    if (minutes < MIN_HELPER_MINUTES) {
      await fail(h, `the ui-designer's commits conflict with yours in ${filesOf(files)} and there is no time left for a second run; the slice is yours`);
      return `the ui-designer's commits conflict with yours in ${filesOf(files)}; no time is left for a re-run: build the slice yourself`;
    }
    const attempt = 2 as const;
    let workspace: Awaited<ReturnType<HelperRunsDeps["helperWorkspace"]["make"]>>;
    try {
      workspace = await deps.helperWorkspace.make(deps.cardPath, P, deps.taskId, h.slice, attempt);
    } catch (error) {
      await fail(h, `the ui-designer's commits conflict with yours and its second workspace could not be made: ${msg(error)}`);
      return `the ui-designer's commits conflict with yours in ${filesOf(files)}, and a re-run could not start: build the slice yourself`;
    }
    Object.assign(h, { attempt, base: P, ref: workspace.ref, workspace: workspace.path, branch: workspace.branch, removed: false, tip: undefined, commits: undefined, controller: linkedController(), deadline: now() + minutes * 60_000 });
    await setState(h, "conflict_rerun");
    launch(h, runOf(h, { files }), contextOf(h, minutes));
    return `the ui-designer's commits conflict with yours in ${filesOf(files)}; it is building the slice again on your latest commits: call slice_wait`;
  }

  /** The pick of a returned helper onto `P`: what the pick made, or the answer's words after the helper went to its next state. */
  async function pickOntoCard(h: Helper, P: string, canRerun: boolean): Promise<{ ok: true; tip: string; picked: string[] } | { ok: false; conflict: boolean; error: string }> {
    let made: Awaited<ReturnType<typeof deps.git.pickOnto>>;
    try {
      made = await deps.git.pickOnto(deps.cardPath, P, h.commits ?? [], deps.identity, `Luna-Helper: ui-designer, slice ${h.slice}`, { task: deps.taskId, slice: h.slice });
    } catch (error) {
      made = { ok: false, conflict: false, reason: msg(error) };
    }
    if (made.ok) return made;
    if (!made.conflict) {
      await fail(h, `the ui-designer's commits could not be picked: ${made.reason}`);
      return { ok: false, conflict: false, error: `the ui-designer's commits could not be picked (${line(made.reason)}); build the slice yourself` };
    }
    if (canRerun && h.attempt < 2) return { ok: false, conflict: true, error: await rerun(h, P, made.files) };
    return { ok: false, conflict: true, error: await mergeConflict(h, made.files) };
  }

  /** The branch moved to the helper's picked commits: record every sha the machine made, then show the branch. */
  async function landed(h: Helper, onto: string, tip: string, picked: string[]): Promise<void> {
    for (const sha of picked) pickedShas.add(sha);
    await row("build.helper_picked", { slice: h.slice, base: h.base, helperTip: h.tip ?? "", onto, picked, tip });
    const shown = await deps.publish?.().catch((error): { ok: false; note: string } => ({ ok: false, note: `the branch could not be shown: ${msg(error)}` }));
    if (shown && !shown.ok) await deps.note?.(`slice ${h.slice}: ${shown.note}`).catch(() => {});
    h.pending = undefined;
  }

  async function onPickRequest(request: PickRequest): Promise<PickAnswer> {
    return serial(async () => {
      const h = helpers.get(request.slice);
      if (!h || (h.state !== "returned" && h.state !== "picking")) {
        if (h && LIVE.has(h.state)) return { ok: false, error: `the ui-designer has not returned slice ${request.slice} yet; call slice_wait` };
        return { ok: false, error: `no ui-designer commits wait for slice ${request.slice}` };
      }
      if (!/^[0-9a-f]{40,64}$/.test(request.head)) return { ok: false, error: "your head is not a commit id" };
      const synced = await deps.importer.sync();
      if (!synced.ok) return { ok: false, error: `your commits could not be taken in yet (${line(synced.reason)}); call slice_list, then slice_wait` };
      // Anything the implementer committed after it bundled is not in the pick's base: it bundles again and asks again.
      if (synced.head !== request.head) return { ok: false, retry: true, error: "your commits are not all in yet" };
      h.pending = undefined;
      const made = await pickOntoCard(h, request.head, true);
      if (!made.ok) return { ok: false, ...(made.conflict ? { conflict: true as const } : {}), error: made.error };
      const dest = join(tmpdir(), `luna-pick-${randomUUID()}.bundle`);
      try {
        const bundled = await deps.git.pickBundle(deps.cardPath, request.head, pickedRef(deps.taskId, h.slice), dest);
        if (!bundled.ok) {
          await fail(h, `the pick's bundle could not be made: ${bundled.reason}`);
          return { ok: false, error: `the pick's bundle could not be made (${line(bundled.reason)}); build the slice yourself` };
        }
        const name = `pick-${request.nonce}-${request.n}.bundle`;
        await writeMailboxFile(deps.outDir, name, dest);
        h.pending = { P: request.head, tip: made.tip, picked: made.picked };
        await setState(h, "picking");
        return { ok: true, tip: made.tip, picked: made.picked, bundle: name };
      } finally {
        await rm(dest, { force: true });
      }
    });
  }

  async function onPickAck(request: PickAck): Promise<PickDone> {
    return serial(async () => {
      const h = helpers.get(request.slice);
      const pending = h?.pending;
      if (!h || !pending) return { ok: false, reason: `no pick is waiting for slice ${request.slice}` };
      // Whatever the answer, this pick is spent: the factory's next call asks again.
      const drop = async (reason: string): Promise<PickDone> => {
        h.pending = undefined;
        if (h.state === "picking") await setState(h, "returned");
        return { ok: false, reason };
      };
      if (request.head !== pending.tip) return drop("your head is not the picked tip");
      const moved = await deps.git.advanceBranch(deps.cardPath, deps.branch, pending.P, pending.tip).catch((error): { ok: false; reason: string } => ({ ok: false, reason: msg(error) }));
      if (!moved.ok) return drop(`the card's branch ${moved.reason === "moved" ? "moved" : "could not move"} since the pick (${moved.reason}); bundle again and call slice_wait`);
      await landed(h, pending.P, pending.tip, pending.picked);
      await setState(h, "committed");
      await release(h);
      return { ok: true };
    });
  }

  /** After a pass: one helper is waited for, picked onto the card's tip and put in `W`. The container is gone, so the folder is updated here (D7). */
  async function finish(h: Helper): Promise<void> {
    if (h.state === "running" || h.state === "conflict_rerun") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([h.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, h.deadline - now()))))]);
      clearTimeout(timer);
    }
    if (h.state !== "returned" && h.state !== "picking") {
      // Still running after its limit: cancelled. Anything else ended on its own and was freed.
      if (LIVE.has(h.state)) await cancel();
      return;
    }
    await serial(async () => {
      const synced = await deps.importer.sync();
      if (!synced.ok) return fail(h, `the card's commits could not be taken in: ${synced.reason}`);
      const P = synced.head;
      // The factory merged the picked tip and its last bundle came in: the branch is there already.
      if (h.pending && P === h.pending.tip) {
        await landed(h, h.pending.P, h.pending.tip, h.pending.picked);
        await setState(h, "committed");
        return release(h);
      }
      h.pending = undefined;
      // The run is over: a conflict here is final, with no second run.
      const made = await pickOntoCard(h, P, false);
      if (!made.ok) return;
      const moved = await deps.git.advanceBranch(deps.cardPath, deps.branch, P, made.tip).catch((error): { ok: false; reason: string } => ({ ok: false, reason: msg(error) }));
      if (!moved.ok) return fail(h, `the card's branch ${moved.reason}: the ui-designer's commits were not put on it`);
      await landed(h, P, made.tip, made.picked);
      const folder = await deps.git.landInWorktree(deps.cardPath, P, made.tip);
      if (!folder.ok) {
        const reason = line(`the ui-designer's slice ${h.slice} is on the branch, but your folder has local changes in ${filesOf(folder.files)}; a person merges them`);
        escalation ??= { escalate: "merge_conflict", reason };
        await setState(h, "merge_conflict", reason);
      } else await setState(h, "committed");
      await release(h);
    });
  }

  return {
    onHelperRequest,
    onPickRequest,
    onPickAck,
    async afterRun(outcome) {
      if (outcome !== "pass") await cancel();
      else {
        for (const h of [...helpers.values()].filter((x) => LIVE.has(x.state))) await finish(h).catch((error) => deps.log?.(`helper not landed: ${msg(error)}`));
        // Anything the landing could not settle is cancelled, never left holding its files.
        await cancel();
      }
      return escalation;
    },
    cancel,
    picked: () => pickedShas,
    delegatedLocks: () => [...new Set([...helpers.values()].filter((h) => LIVE.has(h.state)).flatMap((h) => h.locks.helper))],
  };
}
