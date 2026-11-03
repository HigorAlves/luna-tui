// How a runtime reports a run: it emits RunEvents (contracts/src/events.ts) and core prints the
// transcript from them (transcript.ts) and writes them to /out/events.jsonl (output.ts).
import type { RunEvent } from "@hardness/contracts";

import type { GuardDecision } from "./guards.ts";
import { callTarget } from "./render.ts";

export type Emit = (event: RunEvent) => void;

interface Call {
  tool: string;
  input: Record<string, unknown>;
}

const asInput = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});

/** Joins what a runtime's stream says about a tool call (requested, settled) with what its guard
 *  decided, into one `tool_call` per call and then its `tool_result`. The two arrive on different
 *  channels and in either order, so a guarded call is emitted once both are in; a call no guard
 *  looks at is emitted as soon as it is requested. Whatever is left is emitted by `flush`. */
export class CallJoin {
  private readonly requests = new Map<string, Call>();
  private readonly decisions = new Map<string, Call & { decision: GuardDecision }>();
  private readonly emitted = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly emit: Emit;
  private readonly guarded: (tool: string) => boolean;

  constructor(emit: Emit, guarded: (tool: string) => boolean) {
    this.emit = emit;
    this.guarded = guarded;
  }

  /** The stream shows a call. */
  requested(id: string, tool: string, input: unknown): void {
    this.names.set(id, tool);
    const call = { tool, input: asInput(input) };
    const decided = this.decisions.get(id);
    if (decided) this.call(id, call, decided.decision);
    else if (!this.guarded(tool)) this.call(id, call, { allow: true });
    else this.requests.set(id, call);
  }

  /** The guard decided a call. */
  decided(id: string, tool: string, input: unknown, decision: GuardDecision): void {
    const requested = this.requests.get(id);
    if (requested) this.call(id, requested, decision);
    else if (!this.emitted.has(id)) this.decisions.set(id, { tool, input: asInput(input), decision });
  }

  /** The call ended; a call still waiting on its guard is taken as allowed, since it ran. */
  settled(id: string, ok: boolean, error?: string): void {
    const waiting = this.requests.get(id);
    if (waiting) this.call(id, waiting, { allow: true });
    this.emit({ kind: "tool_result", payload: { id, tool: this.names.get(id) ?? "call", ok, ...(error !== undefined && { error }) } });
  }

  /** Emits every call still waiting: a request as allowed, a decision the stream never showed as decided. */
  flush(): void {
    for (const [id, call] of this.requests) this.call(id, call, { allow: true });
    for (const [id, { decision, ...call }] of this.decisions) this.call(id, call, decision);
  }

  private call(id: string, { tool, input }: Call, decision: GuardDecision): void {
    this.requests.delete(id);
    this.decisions.delete(id);
    if (this.emitted.has(id)) return;
    this.emitted.add(id);
    const { target, fingerprint } = callTarget(tool, input);
    this.emit({
      kind: "tool_call",
      payload: { id, tool, target, ...(fingerprint !== undefined && { fingerprint }), allowed: decision.allow, ...(!decision.allow && { reason: decision.reason }) },
    });
  }
}
