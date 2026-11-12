// The runner's side of the token economy on eve (RFC 0007 §1, §2). The session lives here (it needs the
// judge, the events and the call join); the tools in the eve server report each finished call over the
// loopback bridge (agent/economy.ts), and what the session decides goes back as a redirect to append to
// the tool's result or a stop. The tool's output reaches `settled` and is dropped: only the observation
// is kept, to go on the call's `tool_result` event when the stream shows the call settled.
import type { Observation } from "@hardness/contracts";

import type { EconomySession } from "../../core/economy/session.ts";

/** What the wrapper in the server sends, and what it gets back. */
export interface EconomyReport {
  tool: string;
  input: unknown;
  output: string;
  ok: boolean;
}
export interface EconomyReply {
  append?: string;
  stop?: boolean;
}

/** The names and fields the observer reads (core/economy/observe.ts): eve's file tools under theirs. */
function asSeen(tool: string, input: unknown): { tool: string; input: unknown } {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const name = tool === "read_file" ? "read" : tool === "write_file" ? "write" : tool;
  return { tool: name, input: typeof fields.filePath === "string" ? { ...fields, file_path: fields.filePath } : input };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class EconomyTap {
  private readonly session: EconomySession;
  private readonly onStop: (reason: string, call: { tool: string; input: unknown }) => void;
  /** Observations waiting for the call.settled event of their call; the model's own call id is not known here. */
  private readonly waiting: { tool: string; input: unknown; observation: Observation; ok: boolean }[] = [];
  /** A redirect that came with a call no wrapper reports: there is no result to append it to, so it rides on the next report. */
  private carried: string | undefined;
  private seq = 0;
  private stopped = false;

  constructor(session: EconomySession, onStop: (reason: string, call: { tool: string; input: unknown }) => void) {
    this.session = session;
    this.onStop = onStop;
  }

  /** One finished call, from the bridge. Never throws. */
  report(body: unknown): EconomyReply {
    try {
      // After the stop nothing more is read: the run is ending and its events stop at the call that ended it.
      if (this.stopped) return { stop: true };
      const call = body as Partial<EconomyReport>;
      if (typeof call.tool !== "string" || typeof call.output !== "string") return {};
      const seen = asSeen(call.tool, call.input);
      const { observation, step } = this.session.settled({ id: `eve-${++this.seq}`, ...seen, output: call.output, ok: call.ok !== false });
      if (observation) this.waiting.push({ tool: call.tool, input: call.input, observation, ok: call.ok !== false });
      if (step.kind === "stop") {
        this.stopped = true;
        this.onStop(step.reason, { tool: call.tool, input: call.input });
        return { stop: true };
      }
      const redirect = step.kind === "redirect" ? step.text : undefined;
      const append = [this.carried, redirect].filter((text): text is string => text !== undefined).join("\n\n");
      this.carried = undefined;
      return append ? { append } : {};
    } catch {
      return {};
    }
  }

  /** A call the stream shows settled for a tool no wrapper reports (the luna tools, `delegate`): the machine's envelope counts it, so the
   *  guard does too, with no output to read. A redirect it earns waits for the next report's reply; a stop ends the run on this call. */
  count(tool: string, input: unknown, ok: boolean): void {
    try {
      if (this.stopped) return;
      const { step } = this.session.settled({ id: `eve-${++this.seq}`, tool, input, output: "", ok });
      if (step.kind === "redirect") this.carried = step.text;
      else if (step.kind === "stop") {
        this.stopped = true;
        this.onStop(step.reason, { tool, input });
      }
    } catch {
      // The economy never breaks the run.
    }
  }

  /** The observation of the call the stream shows settled (the same tool and input, else the oldest of that tool), and whether the tool
   *  succeeded: eve settles a command that exited nonzero as completed, the economy reads it as failed, as Claude's hook does. */
  take(tool: string, input: unknown): { observation: Observation; ok: boolean } | undefined {
    let at = this.waiting.findIndex((w) => w.tool === tool && same(w.input, input));
    if (at < 0) at = this.waiting.findIndex((w) => w.tool === tool);
    return at < 0 ? undefined : this.waiting.splice(at, 1)[0];
  }
}
