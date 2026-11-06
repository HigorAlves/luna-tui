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
import type { EgressPolicy } from "./egress-policy.ts";
import { type CredentialOwner, type DecisionRecord, type EngineId, type FactoryConfig, PACKS, type PackId, type RunInfo, type RunInput, type RunResult, credentialOwner, resolveEngine } from "@hardness/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { type Credentials, NoCredentialError } from "../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";
import { type ContextPackId, type PackContext, contextSchema, isContextPack } from "../domain/context-packs.ts";
import { engineProblem, fallbackCandidates } from "../domain/engine-choice.ts";
import type { EngineBudgetWatch } from "./engine-gates.ts";
import { recordContext } from "../domain/record-context.ts";
import { redact } from "../domain/evidence-markdown.ts";
import { redactDeep, secretRedactor } from "../domain/redact-secrets.ts";
import { maskPii } from "../domain/secrets-check.ts";
import { buildContextPackInput } from "../domain/stage-input.ts";
import { type RunFacts, runFacts } from "../domain/task.ts";
import { applyPolicy } from "@hardness/contracts";
import type { DecisionAppender } from "./decision-log.ts";
import { outputError, runPackOnce } from "./stages/run-once.ts";
import { currentTask } from "./task-scope.ts";
import { type Telemetry, noTelemetry } from "./telemetry.ts";

/** How many `POST /runs` calls run at once; the rest wait. */
export const PACK_RUNS_MAX = 2;
/** How many calls may wait for a place; past it a call is refused (QueueFullError). */
export const PACK_RUNS_QUEUE = 8;
/** Where the run folders live under the state dir while a call runs: their own folder, never the
 *  stage runs' `runs/`, so clearing it at start-up touches nothing a stage left. */
export const PACK_RUNS_DIR = "pack-runs";

/** One row per call that ran: never its context nor its answer. */
export interface PackRunRecord extends RunFacts {
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
/** The engine's runtime is turned off on this machine (MACHINE_DISABLE_RUNTIMES): 409, nothing ran. */
export class RunEngineDisabledError extends Error {}
/** The engine is at a monthly cap (MACHINE_ENGINE_BUDGETS): 409 `budget`, nothing ran. */
export class RunEngineBudgetError extends Error {}
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

/** A call as the host makes it: `RunInput` plus where in the pipeline it comes from. `taskId` and `stage`
 *  are never read from a request body (the route parses `RunInput`, which has neither); a call that
 *  names a `stage` is the pipeline's own, the only kind whose context and answer a span may carry. */
export type HostRunInput = RunInput & { taskId?: string; stage?: string };

/** Who is calling, as the process knows it. `own` is passed by the machine's in-process callers only; the HTTP route never passes it,
 *  so a decision record is the machine's own (`origin: "machine"`) whatever an `X-Luna-Client` header says. */
export interface RunOptions {
  own?: boolean;
}

export interface PackRunsPort {
  /** `signal` is the request's: when it aborts, a waiting call is dropped and a running one stopped. */
  run(input: HostRunInput, client: string | null, signal?: AbortSignal, options?: RunOptions): Promise<RunResult>;
}

/** The port the machine's own code calls: every call is marked `own`, so its decision records read `origin: "machine"`. The HTTP route gets the
 *  runs themselves, never this wrapper. */
export function ownCalls(runs: PackRunsPort): PackRunsPort {
  // A call made while a card's stage runs names the card (`task-scope.ts`); a call that already names one keeps its own.
  return { run: (input, client, signal, options) => runs.run(input.taskId === undefined && currentTask() !== undefined ? { ...input, taskId: currentTask()! } : input, client, signal, { ...options, own: true }) };
}

export interface PackRunsDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  credentials: Credentials;
  stateDir: string;
  store: PackRunStore;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  /** The list a pack run may reach; absent, the run joins an ordinary bridge as before. */
  egress?: EgressPolicy;
  now?: () => Date;
  /** Calls at once; defaults to PACK_RUNS_MAX. */
  max?: number;
  /** Calls that may wait; defaults to PACK_RUNS_QUEUE. */
  queue?: number;
  /** The machine's daily ceiling and the day's spend (stage runs and pack runs); none when absent. */
  budget?: { dailyUsd: number | null; spentTodayUsd: () => Promise<number> };
  /** The monthly caps per engine: told about every call with a cost, to raise their alerts. */
  engineBudgets?: Pick<EngineBudgetWatch, "afterRun">;
  /** The credentials whose usage window the pipeline holds right now: a fallback never goes to one. */
  latched?: () => CredentialOwner[];
  /** One line per call; defaults to console.log. Never the context nor the answer. */
  log?: (line: string) => void;
  /** Where each call is reported as a span; the no-op without a backend. */
  telemetry?: Telemetry;
  /** Where a decision pack's validated answer is kept with its context (RFC 0005 wave 7); none keeps nothing. */
  decisions?: DecisionAppender;
  /** Secret values to redact from the context a record stores (the shapes of tokens are always redacted); none by default. */
  secrets?: () => Readonly<Record<string, string>>;
  /** What the call's repository lets the machine keep (its `learning` section) and the repository's folder name; absent, the defaults and no repository.
   *  It can only lower what the machine's own switches allow: `MACHINE_DECISIONS=off` (no `decisions`) and `MACHINE_TRACES` (the telemetry's mode) stay ceilings. */
  learning?: (taskId: string | undefined) => Promise<{ repo: string | null; learning: LearningPolicy }>;
}

/** The `learning` section of a repository's `luna.yaml`, as the machine reads it. */
export type LearningPolicy = FactoryConfig["learning"];
const KEEP_ALL: { repo: string | null; learning: LearningPolicy } = { repo: null, learning: { records: true, context: "full", truth: true, traces: "host" } };
const MODE_RANK = { off: 0, metadata: 1, host: 2, full: 3 } as const;

/** `resetsAt` as the run reported it (epoch seconds, or a string from an older runner), as ISO. */
function resetsIso(resetsAt: number | string | null): string | null {
  if (resetsAt === null) return null;
  const date = typeof resetsAt === "number" ? new Date(resetsAt * 1000) : new Date(resetsAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const isPrivate = (context: PackContext): boolean => (context as { conversation?: { private?: unknown } }).conversation?.private === true;

const usd = (value: number) => `$${value.toFixed(2)}`;

/** Why an engine cannot run a call, as the error the route answers. */
function unavailable(engine: EngineId, found: { reason: string; code?: "disabled" | "budget" }): Error {
  const message = `${engine}: ${found.reason}`;
  if (found.code === "disabled") return new RunEngineDisabledError(message);
  return found.code === "budget" ? new RunEngineBudgetError(message) : new RunNoCredentialError(message);
}

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
  private readonly telemetry: Telemetry;

  constructor(private readonly deps: PackRunsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => console.log(line));
    this.telemetry = deps.telemetry ?? noTelemetry();
  }

  /** Removes run folders a crash left behind: they hold a client's context. */
  async clearLeftovers(): Promise<void> {
    await rm(join(this.deps.stateDir, PACK_RUNS_DIR), { recursive: true, force: true });
  }

  async run(request: HostRunInput, client: string | null, signal?: AbortSignal, options: RunOptions = {}): Promise<RunResult> {
    const { pack } = request;
    if (!isContextPack(pack)) throw new NotOnDemandError(`${pack} is not run on demand: only ${Object.keys(PACKS).filter((id) => isContextPack(id as PackId)).join(", ")} are`);
    let engine = request.engine ?? PACKS[pack].engines.default;
    const problem = engineProblem(pack, engine);
    if (problem) throw new EngineNotAllowedError(problem);
    // A context that does not fit the pack is a ZodError: the route's 400.
    const context = contextSchema(pack).parse(request.context);
    // A decision pack's default engine that cannot run (no credential, runtime off) gives way to
    // the pack's next fallback that can (RFC 0005 rule 1); an engine the caller named never does.
    const found = await this.deps.credentials.check(engine);
    if (!found.available) {
      if (request.engine !== undefined || PACKS[pack].kind !== "decision") throw unavailable(engine, found);
      const next = await this.available(pack, engine, found);
      this.log(`run: ${pack} moves to ${next} for want of ${engine}: ${found.reason}`);
      engine = next;
    }
    await this.checkBudget();

    const waited = await this.acquire(signal);
    try {
      // Calls ahead in the queue may have spent the day's ceiling meanwhile.
      if (waited) await this.checkBudget();
      // A usage limit moves the call to the pack's next fallback engine, in the same place; the
      // client hears rate_limited only once there is none left to try.
      const tried: EngineId[] = [];
      let movedFrom: EngineId | null = null;
      let limit: RunRateLimitedError | null = null;
      for (;;) {
        try {
          return await this.once(pack, context, engine, client, signal, movedFrom, { taskId: request.taskId, stage: request.stage, own: options.own === true });
        } catch (thrown) {
          if (!(thrown instanceof RunRateLimitedError)) throw thrown;
          tried.push(engine);
          limit = sooner(limit, thrown);
          const next = signal?.aborted ? null : await this.fallback(pack, tried);
          if (!next) throw limit;
          this.log(`run: ${pack} moves to ${next} after ${engine} rate limit`);
          movedFrom = engine;
          engine = next;
        }
      }
    } finally {
      this.release();
    }
  }

  /** The first of the pack's fallback engines that can run, when its default cannot (`found` says why).
   *  With none, throws naming every engine tried and what each lacks. */
  private async available(pack: ContextPackId, first: EngineId, found: { reason: string; code?: "disabled" | "budget" }): Promise<EngineId> {
    const problems: Array<[EngineId, { reason: string; code?: "disabled" | "budget" }]> = [[first, found]];
    for (const candidate of fallbackCandidates(PACKS[pack], [first])) {
      const check = await this.deps.credentials.check(candidate);
      if (check.available) return candidate;
      problems.push([candidate, check]);
    }
    if (problems.length === 1) throw unavailable(first, found);
    const codes = new Set(problems.map(([, p]) => p.code));
    const message = `no engine can run ${pack}: ${problems.map(([e, p]) => `${e}: ${p.reason}`).join("; ")}`;
    const only = codes.size === 1 ? [...codes][0] : undefined;
    if (only === "disabled") throw new RunEngineDisabledError(message);
    throw only === "budget" ? new RunEngineBudgetError(message) : new RunNoCredentialError(message);
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
  private async once(pack: ContextPackId, context: PackContext, engine: EngineId, client: string | null, signal?: AbortSignal, movedFrom: EngineId | null = null, origin: { taskId?: string; stage?: string; own?: boolean } = {}): Promise<RunResult> {
    const startedAt = this.now();
    const t0 = Date.now();
    const policy = await this.learningOf(origin.taskId);
    // A repository can lower the trace mode of its own runs, never raise it above the machine's. Its default, `host`, is no cap:
    // a repository that says nothing leaves the machine's own mode (`full` included) alone.
    const mode = policy.learning.traces === "host" ? this.telemetry.mode : (["off", "metadata", "host", "full"] as const)[Math.min(MODE_RANK[this.telemetry.mode], MODE_RANK[policy.learning.traces])]!;
    const span = mode === "off" ? noTelemetry().run({ kind: "pack", pack, engine, client }) : this.telemetry.run({ kind: "pack", pack, engine, client });
    const keepsMore = mode === "host" || mode === "full";
    if (movedFrom) span.event("engine", { engine, reason: `fallback after ${movedFrom} rate limit` });
    const runDir = join(this.deps.stateDir, PACK_RUNS_DIR, `${pack}-${randomUUID()}`);
    const work = join(runDir, "work");
    let usage: RunResult["usage"] = { model: "", engine, turns: 0, durationMs: 0, costUsd: null };
    let answer: Record<string, unknown> | null = null;
    let failure: Error | null = null;
    let facts: RunFacts = {};
    let info: RunInfo | null = null;
    let decided: ReturnType<typeof applyPolicy> | null = null;
    try {
      await mkdir(work, { recursive: true });
      const input = buildContextPackInput(pack, context, engine);
      const run = await runPackOnce(
        { name: `hardness-run-${pack.replace(/_/g, "-")}-${runDir.slice(-12)}`, image: this.deps.image, runDir, worktree: work, input, engine, labels: { luna: "run" }, extraEnv: mode === "full" ? span.childEnv() : {}, signal },
        { credentials: this.deps.credentials, sandbox: this.deps.sandbox, ...(this.deps.egress ? { egress: this.deps.egress } : {}) },
      );
      if (run.error !== null) failure = signal?.aborted ? new RunAbortedError("the client left: the run was stopped") : new RunFailedError(run.error);
      else {
        const out = run.output;
        usage = { model: out.usage.model, engine, turns: out.usage.turns, durationMs: out.usage.durationMs, costUsd: out.usage.costUsd };
        facts = runFacts(out.run);
        info = out.run ?? null;
        if (!out.ok) failure = out.rateLimited ? new RunRateLimitedError(outputError(out), resetsIso(out.resetsAt)) : new RunFailedError(outputError(out));
        else {
          const parsed = PACKS[pack].answer.safeParse(out.answer);
          if (parsed.success) {
            answer = parsed.data as Record<string, unknown>;
            const found = PACKS[pack];
            if (found.kind === "decision") decided = applyPolicy(found, answer);
          } else failure = new RunFailedError(`the answer did not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        }
      }
    } catch (thrown) {
      // The credential went between the check and the run: nothing ran, so nothing is recorded.
      if (thrown instanceof NoCredentialError) failure = new RunNoCredentialError(`${engine}: ${thrown.message}`);
      else failure = new RunFailedError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      // The span ends first: in `full` mode it reads the transcript the folder still holds.
      // What the run is recorded as when the result names no model: the pinned ID it was started on.
      if (!usage.model) usage.model = resolveEngine(engine).modelId;
      if (usage.durationMs === 0) usage.durationMs = Date.now() - t0;
      if (failure instanceof RunRateLimitedError) span.event("rate_limited", { resetsAt: failure.resetsAt });
      // What the span carries from the call is worked out first, and a failure there is only a span without it: the span still ends and the run folder still goes.
      let carried: { input: Record<string, unknown>; output: Record<string, unknown> } | null = null;
      if (keepsMore && decided && origin.own === true) {
        try {
          carried = { input: this.spanInput(context) as Record<string, unknown>, output: redactDeep({ answer: answer!, verdicts: decided.verdicts, overall: decided.overall }, this.scrubber()) as Record<string, unknown> };
        } catch (thrown) {
          console.warn(`run: could not prepare the span's input: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
        }
      }
      await span.end({
        outcome: failure === null ? "pass" : failure instanceof RunRateLimitedError ? "rate_limited" : "fail",
        engine,
        error: failure?.message ?? null,
        model: usage.model,
        turns: usage.turns,
        costUsd: usage.costUsd,
        durationMs: usage.durationMs,
        info,
        // A transcript holds the model's own text (the draft reply to a DM) and a client's context: only the machine's own call, and
        // never a private conversation's, may send it, and what leaves passes the stored copy's redaction and the personal-data masking.
        ...(keepsMore && origin.own === true && !isPrivate(context) ? { transcriptPath: join(runDir, "transcript.log"), scrub: this.scrubber() } : {}),
        ...(carried ?? {}),
      });
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
    const recordId = decided && answer ? await this.keep({ pack, engine, model: usage.model, client, taskId: origin.taskId, stage: origin.stage, own: origin.own === true, policy, context, answer, decided, usage, movedFrom, traceId: span.traceId() }) : undefined;
    if (!(failure instanceof RunNoCredentialError)) await this.record({ pack, engine, model: usage.model, client, ok: failure === null, error: failure?.message ?? null, turns: usage.turns, durationMs: usage.durationMs, costUsd: usage.costUsd, startedAt: startedAt.toISOString(), endedAt: this.now().toISOString(), ...facts });
    if (usage.costUsd) await this.deps.engineBudgets?.afterRun(engine, { taskId: null, repo: null }).catch((thrown: unknown) => console.warn(`run: could not check the engine's cap: ${thrown instanceof Error ? thrown.message : String(thrown)}`));
    const cost = usage.costUsd === null ? "" : ` · $${usage.costUsd.toFixed(4)}`;
    this.log(failure ? `run: ${pack} on ${engine}${client ? ` for ${client}` : ""} failed: ${failure.message}` : `run: ${pack} on ${engine}${client ? ` for ${client}` : ""}, ${usage.turns} turn(s)${cost}`);
    if (failure) throw failure;
    return { answer: answer!, usage, ...(recordId ? { recordId } : {}) };
  }

  /** What a span of the machine's own decision call carries as input: the stored copy of the context (secrets redacted, a private
   *  conversation's text gone) with email addresses and phone numbers masked. A private conversation's span says only that it was one. */
  /** The machine's secret values, then the token shapes, then email addresses and phone numbers: what any text bound for the trace tool passes. */
  private scrubber(): (text: string) => string {
    const secret = secretRedactor(this.deps.secrets?.() ?? {});
    return (text) => maskPii(redact(secret(text)));
  }

  private spanInput(context: PackContext): { context: Record<string, unknown> } | { private: true } {
    const stored = recordContext(context as Record<string, unknown>, { secrets: this.deps.secrets?.() ?? {} });
    if (isPrivate(context)) return { private: true };
    return { context: redactDeep(stored.context, this.scrubber()) as Record<string, unknown> };
  }

  /** Keeps a decision pack's validated answer with its context; the record's id, or undefined when none was kept.
   *  A log that cannot write never fails the call. */
  private async learningOf(taskId: string | undefined): Promise<{ repo: string | null; learning: LearningPolicy }> {
    try {
      return (await this.deps.learning?.(taskId)) ?? KEEP_ALL;
    } catch (thrown) {
      console.warn(`run: could not read the repository's learning section, using the defaults: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      return KEEP_ALL;
    }
  }

  private async keep(call: { policy: { repo: string | null; learning: LearningPolicy }; pack: PackId; engine: EngineId; model: string; client: string | null; taskId?: string; stage?: string; own: boolean; context: PackContext; answer: Record<string, unknown>; decided: ReturnType<typeof applyPolicy>; usage: RunResult["usage"]; movedFrom: EngineId | null; traceId: string | null }): Promise<string | undefined> {
    if (!this.deps.decisions || !call.policy.learning.records) return undefined;
    // The stored copy is redacted, and a private conversation's text is gone; the model was given the real context.
    const stored = recordContext(call.context as Record<string, unknown>, { secrets: this.deps.secrets?.() ?? {} });
    const record: DecisionRecord = {
      schema: 1,
      id: randomUUID(),
      pack: call.pack,
      engine: call.engine,
      model: call.model,
      at: this.now().toISOString(),
      client: call.client,
      ...(call.taskId !== undefined ? { taskId: call.taskId } : {}),
      ...(call.stage !== undefined ? { stage: call.stage } : {}),
      // `context: "answers"` keeps the answer and nothing the model read: the record can still take a truth, it cannot become a case.
      context: call.policy.learning.context === "answers" ? {} : stored.context,
      ...(call.policy.repo ? { repo: call.policy.repo } : {}),
      answer: call.answer,
      verdicts: call.decided.verdicts,
      overall: call.decided.overall,
      traceId: call.traceId,
      origin: call.own ? "machine" : "client",
      ...((call.context as { conversation?: { private?: unknown } }).conversation?.private === true ? { private: true } : {}),
      // No repository is known to a pack call yet: what the machine did is the verdict under the pack's own bars.
      acted: { overall: call.decided.overall, below: call.decided.below, overrides: false },
      usage: { costUsd: call.usage.costUsd, durationMs: call.usage.durationMs, ...(call.movedFrom ? { movedFrom: call.movedFrom } : {}) },
      redacted: call.policy.learning.context === "answers" ? 0 : stored.redacted,
    };
    try {
      await this.deps.decisions.append(record);
      return record.id;
    } catch (thrown) {
      console.warn(`run: could not keep the decision record: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      return undefined;
    }
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
