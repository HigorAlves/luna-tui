// The runner's side of a native subagent (RFC 0002, phase 7; compile.ts's `delegate` workflow tool).
// The parent's agent calls `delegate`; for a helper that is a native subagent the tool asks this
// class's `start` for the child's prompt, then opens the child itself with ctx.agent. The child
// runs inside the eve server, so what `delegate` does for a child on the bridge (core/delegate.ts)
// is done here by following its stream: its limits come out of what the parent has left
// (prepareChild, the same checks), the runner counts its model calls and cancels it at its turn cap
// or its time limit, its folder /out/children/<n>/ is written when it ends, and the parent's
// stream gets a `child` event as it starts and as it ends. Children run one at a time. The child's
// spend is not added to the parent's: eve records it on the parent's own stream as usage (the
// parent's TurnFollower counts it there), so `spent.costUsd` is for reporting, never added.
import type { AgentRole, EngineId, RunEvent } from "@hardness/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { type ChildOptions, type PreparedChild, prepareChild } from "../../core/delegate.ts";
import type { Emit } from "../../core/events.ts";
import { runInfo } from "../../core/fingerprint.ts";
import { lunaHandlers } from "../../core/luna-tools.ts";
import { EMPTY_RUN, type RunOutcome, finish, settle, timeRanOut } from "../../core/output.ts";
import type { Runtime } from "../../core/runtime.ts";
import { eveSubagents } from "./compile.ts";
import { type SessionEvent, TurnFollower } from "./follower.ts";

/** How long a cancelled child may take to settle before the runner stops following it. */
const CANCEL_GRACE_MS = 5_000;

/** A child's session as the parent's handle gives it: read-only, with the id the cancel needs. */
export interface ChildStream {
  readonly id: string;
  /** The agent the child runs: a native subagent's role. */
  readonly name: string;
  stream(options?: { signal?: AbortSignal }): AsyncIterable<SessionEvent>;
}

/** The parent's session: the handle of the child a `child.opened` event announced, and the cancel
 *  of one child (eve's session handle for the child's id), never of the parent. */
export interface ParentSession {
  agent(opened: SessionEvent): ChildStream;
  cancelChild(id: string): Promise<unknown>;
}

export interface ChildrenOptions extends ChildOptions {
  emit: Emit;
  /** The runtime the children are recorded under in their folders (the fingerprint). */
  runtime?: Runtime;
}

interface Child {
  n: number;
  helper: { role: AgentRole; engine: EngineId };
  prepared: PreparedChild;
  events: RunEvent[];
  emit: Emit;
  session: ParentSession | null;
  /** Cancels the child, once its stream is followed. */
  cancel: (() => void) | null;
  timedOut: boolean;
  ended: boolean;
  /** Ends the child: the next `start` goes on. */
  release: () => void;
  settled: Promise<void>;
  timer: NodeJS.Timeout;
}

const Args = z.object({ helper: z.string(), message: z.string().min(1) });

export class SubagentChildren {
  /** What the children have spent: their turns count against the next child's limits. */
  readonly spent: { costUsd: number | null; turns: number } = { costUsd: null, turns: 0 };
  private readonly o: ChildrenOptions;
  private count = 0;
  private last: Promise<void> = Promise.resolve();
  private current: Child | null = null;
  private closed = false;

  constructor(o: ChildrenOptions) {
    this.o = o;
  }

  /** The bridge's helper_start: the child's prompt, or why it cannot run. A second call waits for the first child to end. */
  start(args: unknown): Promise<{ prompt: string } | { error: string }> {
    const before = this.last;
    let release!: () => void;
    this.last = new Promise<void>((resolve) => (release = resolve));
    return before.then(() => this.begin(args, release));
  }

  private begin(args: unknown, release: () => void): { prompt: string } | { error: string } {
    const refuse = (error: string) => {
      release();
      return { error };
    };
    if (this.closed) return refuse("the stage is ending: no helper can start");
    const parsed = Args.safeParse(args ?? {});
    if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; "));
    const helper = eveSubagents(this.o.pack).find((h) => h.role === parsed.data.helper);
    if (!helper) return refuse(`${parsed.data.helper} is not a helper of this stage`);
    const n = this.count + 1;
    let prepared: PreparedChild | { error: string };
    try {
      prepared = prepareChild(this.o, helper, parsed.data.message, n, this.spent.turns);
    } catch (e) {
      return refuse(`the helper could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ("error" in prepared) return refuse(`${helper.role} on ${helper.engine} gave no answer: ${prepared.error}. Go on without it.`);
    this.count = n;
    mkdirSync(prepared.out, { recursive: true });
    writeFileSync(join(prepared.out, "prompt.md"), prepared.prompt);
    const events: RunEvent[] = [];
    let settled!: () => void;
    const child: Child = {
      n,
      helper,
      prepared,
      events,
      emit: (event) => events.push(event),
      session: null,
      cancel: null,
      timedOut: false,
      ended: false,
      release,
      settled: new Promise<void>((resolve) => (settled = resolve)),
      timer: setTimeout(() => this.expire(child), prepared.limits.timeoutMs),
    };
    child.timer.unref();
    child.release = () => {
      release();
      settled();
    };
    this.current = child;
    this.o.emit({ kind: "child", payload: { phase: "start", ...this.ids(child) } });
    return { prompt: prepared.prompt };
  }

  /** A parent stream event; on child.opened for the helper that was just started, follows it until it
   *  ends. Any other child the parent's session opens is never taken for it. */
  take(event: SessionEvent, session: ParentSession): void {
    if (event.type !== "child.opened") return;
    const child = this.current;
    if (!child || child.session) return;
    const stream = session.agent(event);
    if (stream.name !== child.helper.role) return;
    child.session = session;
    void this.follow(child, stream, session);
  }

  /** Children still running when the parent ends: cancelled, their folders written. */
  async close(): Promise<void> {
    this.closed = true;
    const child = this.current;
    if (!child || child.ended) return;
    if (child.cancel) {
      child.cancel();
      await child.settled;
    } else this.end(child, { ...EMPTY_RUN, error: "the stage ended before the helper started" });
  }

  private ids(c: Child) {
    return { runId: `child-${c.n}`, pack: this.o.pack.id, role: c.helper.role, engine: c.helper.engine };
  }

  /** The child's time ran out: cancelled while it runs, ended at once when it never opened. */
  private expire(child: Child): void {
    if (child.ended) return;
    child.timedOut = true;
    if (child.cancel) child.cancel();
    else this.end(child, { ...EMPTY_RUN, error: timeRanOut(child.prepared.limits.timeoutMs) });
  }

  private async follow(child: Child, stream: ChildStream, session: ParentSession): Promise<void> {
    const { pack, engine, limits } = child.prepared;
    const turn = new TurnFollower(pack, limits.maxTurns, child.emit, engine.modelId);
    const abort = new AbortController();
    const started = Date.now();
    let cancelled = false;
    child.cancel = () => {
      if (cancelled) return;
      cancelled = true;
      session.cancelChild(stream.id).catch(() => {});
      setTimeout(() => abort.abort(), CANCEL_GRACE_MS).unref();
    };
    if (child.timedOut) child.cancel();
    try {
      for await (const event of stream.stream({ signal: abort.signal })) {
        if (turn.take(event)) child.cancel();
        if (event.type === "turn.settled" || event.type === "session.ended") break;
      }
    } catch (e) {
      if (!abort.signal.aborted) turn.result.error = e instanceof Error ? e.message : String(e);
    } finally {
      abort.abort();
    }
    turn.calls.flush();
    const result = turn.result;
    result.durationMs = Date.now() - started;
    if (!result.ok) {
      if (child.timedOut) Object.assign(result, { structured: null, rateLimited: false, error: timeRanOut(limits.timeoutMs) });
      else result.error ??= "the helper's stream ended with no answer";
    }
    this.end(child, settle(result, pack));
  }

  /** Writes the child's folder, says it ended, counts what it spent and lets the next child start. */
  private end(child: Child, run: RunOutcome): void {
    if (child.ended) return;
    child.ended = true;
    clearTimeout(child.timer);
    const { pack, engine, out } = child.prepared;
    {
      const luna = lunaHandlers({ ledgerPath: join(out, "ledger.json"), decisions: this.o.input.decisions, emit: child.emit });
      if (run.rateLimited) child.emit({ kind: "rate_limit", payload: { resetsAt: run.resetsAt } });
      const info = this.o.runtime ? runInfo(this.o.runtime, engine, pack, child.prepared.template, this.o.paths.factoryRoot) : null;
      finish(out, pack, run, { ledger: luna.state.ledger, events: child.events, run: info });
    }
    this.spent.turns += run.turns;
    if (run.costUsd !== null) this.spent.costUsd = (this.spent.costUsd ?? 0) + run.costUsd;
    this.o.emit({ kind: "child", payload: { phase: "end", ...this.ids(child), ok: run.ok, ...(run.error !== null && { error: run.error }), costUsd: run.costUsd } });
    if (this.current === child) this.current = null;
    child.release();
  }
}
