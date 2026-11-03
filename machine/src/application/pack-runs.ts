// Packs on demand (`POST /runs`, RFC 0004): one context-only pack run on data a client sends,
// with no task and no worktree. It runs like the Slack inbox's triage: runPackOnce in the stage
// container over an empty /work, only the engine's credential, the answer validated against the
// pack's schema.
//
// What is kept: one pack_runs row per call that ran (pack, engine, model, client, ok, error,
// turns, duration, cost, times). What is not: the context the client sent and the answer. The
// run folder (`<stateDir>/pack-runs/<pack>-<uuid>`, which holds both in stage.json, result.json
// and the transcript; never the stage runs' `runs/`) is removed when the call ends, whether it
// answered or failed, and any left by a crash is removed at start-up: the notch never keeps
// message text on disk, so the machine does not either.
//
// Concurrency: calls have their own small cap (PACK_RUNS_MAX), not the stage pool's slots. The
// pool counts tasks the pipeline claims and drains; an on-demand call is short (a few turns on
// Haiku), someone is waiting on it, and it must not queue behind a 30-minute implementing stage,
// nor take a task's slot. Calls past the cap wait for one to finish, first come first served, up
// to PACK_RUNS_QUEUE of them; past that a call is refused at once. A call whose client leaves is
// dropped while it waits, and its container stopped while it runs.
//
// Usage limits: a call that hits one runs again at once on the pack's next fallback engine
// (`engines.fallback`) whose credential is here and whose window neither it nor the pipeline
// holds, in the same place; each run is its own pack_runs row, and the answer names the engine
// that gave it. Only once there is none left is the call refused with when the window resets.
//
// Spend: a call's cost is a pack_runs row the day's budget counts (spendSinceUsd), and a call
// while the day is at its ceiling is refused before it runs. There is no monthly ceiling here:
// that one is per repo (luna.yaml), and a call has no repo.
import { type CredentialOwner, type EngineId, PACKS, type PackId, type RunInput, type RunResult, credentialOwner, resolveEngine } from "@hardness/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { type Credentials, NoCredentialError } from "../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";
import { type ContextPackId, type PackContext, contextSchema, isContextPack } from "../domain/context-packs.ts";
import { engineProblem, fallbackCandidates } from "../domain/engine-choice.ts";
import { buildContextPackInput } from "../domain/stage-input.ts";
import { outputError, runPackOnce } from "./stages/run-once.ts";

/** How many `POST /runs` calls run at once; the rest wait. */
export const PACK_RUNS_MAX = 2;
/** How many calls may wait for a place; past it a call is refused (QueueFullError). */
export const PACK_RUNS_QUEUE = 8;
/** Where the run folders live under the state dir while a call runs: their own folder, never the
 *  stage runs' `runs/`, so clearing it at start-up touches nothing a stage left. */
export const PACK_RUNS_DIR = "pack-runs";

/** One row per call that ran: never its context nor its answer. */
export interface PackRunRecord {
  pack: PackId;
  engine: EngineId;
  model: string;
  /** Who asked, from the `X-Luna-Client` header (`notch`); null when unnamed. */
  client: string | null;
  ok: boolean;
  error: string | null;
  turns: number;
  durationMs: number;
  costUsd: number | null;
  startedAt: string;
  endedAt: string;
}

export interface PackRunStore {
  record(run: PackRunRecord): Promise<void>;
}

/** The pack runs in a task state, or is kept from clients (eval_judge): 400. */
export class NotOnDemandError extends Error {}
/** The engine is not one the pack allows: 400. */
export class EngineNotAllowedError extends Error {}
/** This machine lacks the engine's credential: 409, nothing ran. */
export class RunNoCredentialError extends Error {}
/** The pack ran and gave no valid answer: 422 with the run's error. */
export class RunFailedError extends Error {}
/** Every place is taken and the waiting list is full: 429, nothing ran. */
export class QueueFullError extends Error {}
/** The day's spend is at its ceiling: 429, nothing ran. */
export class RunOverBudgetError extends Error {}
/** The client left: dropped while it waited, or its container stopped while it ran. */
export class RunAbortedError extends Error {}
/** The engine's usage limit: 429 with when it resets (ISO), when the run said. */
export class RunRateLimitedError extends Error {
  constructor(
    message: string,
    readonly resetsAt: string | null,
  ) {
    super(message);
  }
}

export interface PackRunsPort {
  /** `signal` is the request's: when it aborts, a waiting call is dropped and a running one stopped. */
  run(input: RunInput, client: string | null, signal?: AbortSignal): Promise<RunResult>;
}

export interface PackRunsDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  credentials: Credentials;
  stateDir: string;
  store: PackRunStore;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  now?: () => Date;
  /** Calls at once; defaults to PACK_RUNS_MAX. */
  max?: number;
  /** Calls that may wait; defaults to PACK_RUNS_QUEUE. */
  queue?: number;
  /** The machine's daily ceiling and the day's spend (stage runs and pack runs); none when absent. */
  budget?: { dailyUsd: number | null; spentTodayUsd: () => Promise<number> };
  /** The credentials whose usage window the pipeline holds right now: a fallback never goes to one. */
  latched?: () => CredentialOwner[];
  /** One line per call; defaults to console.log. Never the context nor the answer. */
  log?: (line: string) => void;
}

/** `resetsAt` as the run reported it (epoch seconds, or a string from an older runner), as ISO. */
function resetsIso(resetsAt: number | string | null): string | null {
  if (resetsAt === null) return null;
  const date = typeof resetsAt === "number" ? new Date(resetsAt * 1000) : new Date(resetsAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** Of two usage limits, the one whose window opens first: what a client waits for to try again. */
function sooner(a: RunRateLimitedError | null, b: RunRateLimitedError): RunRateLimitedError {
  if (!a?.resetsAt) return b;
  return b.resetsAt && b.resetsAt < a.resetsAt ? b : a;
}

export class PackRuns implements PackRunsPort {
  private active = 0;
  private readonly waiting: Array<{ grant: () => void }> = [];
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: PackRunsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Removes run folders a crash left behind: they hold a client's context. */
  async clearLeftovers(): Promise<void> {
    await rm(join(this.deps.stateDir, PACK_RUNS_DIR), { recursive: true, force: true });
  }

  async run(request: RunInput, client: string | null, signal?: AbortSignal): Promise<RunResult> {
    const { pack } = request;
    if (!isContextPack(pack)) throw new NotOnDemandError(`${pack} is not run on demand: only ${Object.keys(PACKS).filter((id) => isContextPack(id as PackId)).join(", ")} are`);
    let engine = request.engine ?? PACKS[pack].engines.default;
    const problem = engineProblem(pack, engine);
    if (problem) throw new EngineNotAllowedError(problem);
    // A context that does not fit the pack is a ZodError: the route's 400.
    const context = contextSchema(pack).parse(request.context);
    const found = await this.deps.credentials.check(engine);
    if (!found.available) throw new RunNoCredentialError(`${engine}: ${found.reason}`);
    await this.checkBudget();

    const waited = await this.acquire(signal);
    try {
      // Calls ahead in the queue may have spent the day's ceiling meanwhile.
      if (waited) await this.checkBudget();
      // A usage limit moves the call to the pack's next fallback engine, in the same place; the
      // client hears rate_limited only once there is none left to try.
      const tried: EngineId[] = [];
      let limit: RunRateLimitedError | null = null;
      for (;;) {
        try {
          return await this.once(pack, context, engine, client, signal);
        } catch (thrown) {
          if (!(thrown instanceof RunRateLimitedError)) throw thrown;
          tried.push(engine);
          limit = sooner(limit, thrown);
          const next = signal?.aborted ? null : await this.fallback(pack, tried);
          if (!next) throw limit;
          this.log(`run: ${pack} moves to ${next} after ${engine} rate limit`);
          engine = next;
        }
      }
    } finally {
      this.release();
    }
  }

  /** The pack's next fallback after a usage limit on each of `tried`: one whose window neither a
   *  tried engine nor the pipeline holds, and whose credential this machine has; else null. */
  private async fallback(pack: ContextPackId, tried: EngineId[]): Promise<EngineId | null> {
    const held = new Set<CredentialOwner>([...tried.map(credentialOwner), ...(this.deps.latched?.() ?? [])]);
    for (const candidate of fallbackCandidates(PACKS[pack], tried)) {
      if (held.has(credentialOwner(candidate))) continue;
      if ((await this.deps.credentials.check(candidate)).available) return candidate;
    }
    return null;
  }

  /** One run of the pack on one engine, in a place already taken: its answer, or the error that ended it. */
  private async once(pack: ContextPackId, context: PackContext, engine: EngineId, client: string | null, signal?: AbortSignal): Promise<RunResult> {
    const startedAt = this.now();
    const t0 = Date.now();
    const runDir = join(this.deps.stateDir, PACK_RUNS_DIR, `${pack}-${randomUUID()}`);
    const work = join(runDir, "work");
    let usage: RunResult["usage"] = { model: "", engine, turns: 0, durationMs: 0, costUsd: null };
    let answer: Record<string, unknown> | null = null;
    let failure: Error | null = null;
    try {
      await mkdir(work, { recursive: true });
      const input = buildContextPackInput(pack, context, engine);
      const run = await runPackOnce(
        { name: `hardness-run-${pack.replace(/_/g, "-")}-${runDir.slice(-12)}`, image: this.deps.image, runDir, worktree: work, input, engine, labels: { luna: "run" }, signal },
        { credentials: this.deps.credentials, sandbox: this.deps.sandbox },
      );
      if (run.error !== null) failure = signal?.aborted ? new RunAbortedError("the client left: the run was stopped") : new RunFailedError(run.error);
      else {
        const out = run.output;
        usage = { model: out.usage.model, engine, turns: out.usage.turns, durationMs: out.usage.durationMs, costUsd: out.usage.costUsd };
        if (!out.ok) failure = out.rateLimited ? new RunRateLimitedError(outputError(out), resetsIso(out.resetsAt)) : new RunFailedError(outputError(out));
        else {
          const parsed = PACKS[pack].answer.safeParse(out.answer);
          if (parsed.success) answer = parsed.data as Record<string, unknown>;
          else failure = new RunFailedError(`the answer did not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        }
      }
    } catch (thrown) {
      // The credential went between the check and the run: nothing ran, so nothing is recorded.
      if (thrown instanceof NoCredentialError) failure = new RunNoCredentialError(`${engine}: ${thrown.message}`);
      else failure = new RunFailedError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
    // What the run is recorded as when the result names no model: the pinned ID it was started on.
    if (!usage.model) usage.model = resolveEngine(engine).modelId;
    if (usage.durationMs === 0) usage.durationMs = Date.now() - t0;
    if (!(failure instanceof RunNoCredentialError)) await this.record({ pack, engine, model: usage.model, client, ok: failure === null, error: failure?.message ?? null, turns: usage.turns, durationMs: usage.durationMs, costUsd: usage.costUsd, startedAt: startedAt.toISOString(), endedAt: this.now().toISOString() });
    const cost = usage.costUsd === null ? "" : ` · $${usage.costUsd.toFixed(4)}`;
    this.log(failure ? `run: ${pack} on ${engine}${client ? ` for ${client}` : ""} failed: ${failure.message}` : `run: ${pack} on ${engine}${client ? ` for ${client}` : ""}, ${usage.turns} turn(s)${cost}`);
    if (failure) throw failure;
    return { answer: answer!, usage };
  }

  private async record(run: PackRunRecord): Promise<void> {
    try {
      await this.deps.store.record(run);
    } catch (thrown) {
      console.warn(`run: could not record the run: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  }

  private async checkBudget(): Promise<void> {
    const budget = this.deps.budget;
    if (!budget || budget.dailyUsd === null) return;
    const spent = await budget.spentTodayUsd();
    if (spent >= budget.dailyUsd) throw new RunOverBudgetError(`budget: ${usd(spent)} spent today of ${usd(budget.dailyUsd)}`);
  }

  /** Takes a place, waiting for one when all are taken; true when it waited. Rejects with
   *  QueueFullError when the waiting list is full, RunAbortedError when the client left first. */
  private async acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw new RunAbortedError("the client left before the run started");
    if (this.active < (this.deps.max ?? PACK_RUNS_MAX)) {
      this.active++;
      return false;
    }
    const queue = this.deps.queue ?? PACK_RUNS_QUEUE;
    if (this.waiting.length >= queue) throw new QueueFullError(`${this.active} call(s) running and ${this.waiting.length} waiting: try again shortly`);
    // A finishing call hands its place straight to the next one waiting.
    await new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new RunAbortedError("the client left before the run started"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
    });
    return true;
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.active--;
  }
}
