// Follows one eve session's events (the stage's, or a native subagent's child) into a run's outcome
// and its events: the tool calls joined with their approvals, usage, the answer, and when the
// turn has to be cancelled.
import type { Pack } from "@hardness/contracts";

import { CallJoin, type Emit } from "../../core/events.ts";
import { EMPTY_RUN, type RunOutcome, budgetSpent } from "../../core/output.ts";
import { eveTokens, sumTokens } from "../../core/usage.ts";
import { GUARDED } from "./compile.ts";

/** One session event as the follower reads it. */
export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** Follows one turn's session events into the run's outcome and its events, and says when
 *  the turn must be cancelled: when the run's last allowed model call settles without an answer
 *  (eve retries an answer off the schema without a limit of its own), or when the turn pauses
 *  for input nobody can give. */
export class TurnFollower {
  readonly result: RunOutcome = { ...EMPTY_RUN };
  /** The tool calls: a guarded one is emitted once its approval settled, the rest when requested. */
  readonly calls: CallJoin;
  private readonly runs = new Set<string>();
  private modelCalls = 0;
  private capped = false;
  private paused = false;
  private replyText = "";
  private failure: string | null = null;

  private readonly pack: Pick<Pack, "id" | "answer">;
  private readonly maxTurns: number;
  private readonly emit: Emit;
  private readonly model: string;

  constructor(pack: Pick<Pack, "id" | "answer">, maxTurns: number, emit: Emit, model = "") {
    this.pack = pack;
    this.maxTurns = maxTurns;
    this.emit = emit;
    this.model = model;
    this.calls = new CallJoin(emit, (tool) => GUARDED.has(tool));
  }

  /** Takes one event; true when the turn must be cancelled now. */
  take(event: SessionEvent): boolean {
    const data = event.data ?? {};
    const result = this.result;
    if (event.type === "model.requested" && (data.owner as { turnId?: string } | undefined)?.turnId) {
      this.modelCalls++;
      this.runs.add(String(data.runId));
      result.turns = this.modelCalls;
      // A call past the cap that started before the cancel landed.
      return this.cap(this.modelCalls > this.maxTurns);
    }
    if (event.type === "model.settled" && data.error) {
      // A model error eve will not retry ends the session and cancels the turn: keep its reason.
      const error = data.error as { code?: string; message?: string };
      this.failure = `${error.code ?? "error"}: ${error.message ?? ""}`;
      return false;
    }
    if (event.type === "model.settled") return this.cap(this.runs.has(String(data.runId)) && this.modelCalls >= this.maxTurns && result.structured === null);
    if (event.type === "session.ended" && data.error) {
      const error = data.error as { code?: string; message?: string };
      this.failure = `${error.code ?? "error"}: ${error.message ?? ""}`;
    } else if (event.type === "content.completed") {
      if (data.kind === "result") result.structured = data.value as Record<string, unknown>;
      else if (data.kind === "text" && typeof data.value === "string") {
        this.emit({ kind: "text", payload: { text: data.value } });
        if (data.phase === "reply") this.replyText = data.value;
      }
    } else if (event.type === "call.requested") {
      this.calls.requested(String(data.callId), (data.capability as { name?: string } | undefined)?.name ?? "tool", data.input ?? {});
    } else if (event.type === "call.started") {
      // The call cleared its approval (or needed none): the guard allowed it.
      this.calls.decided(String(data.callId), "", {}, { allow: true });
    } else if (event.type === "call.settled") {
      const id = String(data.callId);
      const error = data.error as { message?: string } | undefined;
      // A rejected call never started: in a stage nobody approves by hand, so the guard refused it.
      if (data.outcome === "rejected") this.calls.decided(id, "", {}, { allow: false, reason: error?.message ?? "rejected" });
      const ok = data.outcome === "completed";
      this.calls.settled(id, ok, ok ? undefined : `${String(data.outcome)}: ${error?.message ?? ""}`);
    } else if (event.type === "usage.recorded") {
      const usage = data.usage as { costUsd?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;
      if (typeof usage?.costUsd === "number") result.costUsd = (result.costUsd ?? 0) + usage.costUsd;
      result.tokens = sumTokens(result.tokens, eveTokens(usage));
      this.emit({
        kind: "usage",
        payload: {
          model: this.model,
          ...(typeof usage?.inputTokens === "number" && { inputTokens: usage.inputTokens }),
          ...(typeof usage?.outputTokens === "number" && { outputTokens: usage.outputTokens }),
          ...(typeof usage?.costUsd === "number" && { costUsd: usage.costUsd }),
        },
      });
    } else if (event.type === "turn.paused" && !this.capped) {
      // eve asks to continue past the pack's compiled token budget (approvals never ask here):
      // nobody is here to answer, and no provider reset would resume it.
      this.paused = true;
      return this.cap(true);
    } else if (event.type === "turn.settled") {
      this.settle(data.outcome, data.error as { code?: string; message?: string } | undefined);
    }
    return false;
  }

  /** Marks the turn capped the first time `when` holds; true then, so the caller cancels once. */
  private cap(when: boolean): boolean {
    if (!when || this.capped) return false;
    this.capped = true;
    return true;
  }

  private settle(outcome: unknown, error: { code?: string; message?: string } | undefined): void {
    const result = this.result;
    if (outcome === "completed" && result.structured !== null) {
      result.ok = true;
      return;
    }
    // The model may have answered in text instead of through the reply tool: taken only when the
    // text is an answer the pack's schema accepts, never on the strength of a leading brace.
    const fromText = this.answerFromText();
    if (fromText !== null) {
      Object.assign(result, { ok: true, structured: fromText, text: this.replyText, error: null });
      return;
    }
    result.ok = false;
    result.structured = null;
    if (this.paused || error?.code === "SESSION_USAGE_LIMIT_REACHED") result.error = budgetSpent(`its token budget for ${this.maxTurns} turns ran out before an answer`);
    else if (this.capped) result.error = `no answer the ${this.pack.id} schema accepts within ${this.maxTurns} model calls`;
    else result.error = error?.message ? `${error.code ?? "error"}: ${error.message}` : (this.failure ?? String(outcome));
    if (/\b429\b|too many requests/i.test(`${result.error} ${this.failure ?? ""}`)) result.rateLimited = true;
  }

  private answerFromText(): Record<string, unknown> | null {
    try {
      const parsed = this.pack.answer.safeParse(JSON.parse(this.replyText));
      return parsed.success ? (parsed.data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
