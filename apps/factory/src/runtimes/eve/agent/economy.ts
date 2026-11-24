// The token economy inside the eve server (RFC 0007): each finished call of a guarded tool is
// reported to the runner over the bridge, which holds the session; what comes back is a redirect to
// append to what the model reads, or a stop. The output goes to the bridge only, never into an event.
// Fails open: no economy in the run (the runner leaves LUNA_EVE_ECONOMY unset: no call, no wait), a
// bridge fault or an answer after WAIT_MS leaves the result as the tool made it.
import { bridge } from "./bridge.ts";

/** What the runner is given of an output, as the observer reads it. */
export const OUTPUT_CAP = 20_000;
const WAIT_MS = 2_000;
const MARK = "\n--- process check ---\n";
const ENDING = "The run is ending: the process check found it stuck, and the stage stops here.";

export interface Taps {
  enabled(): boolean;
  send(body: Record<string, unknown>): Promise<unknown>;
  waitMs?: number;
}

const real: Taps = { enabled: () => process.env.LUNA_EVE_ECONOMY === "1", send: (body) => bridge("economy", body, WAIT_MS) };

/** A tool's output as the text the observer reads. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null) {
    const o = output as { stdout?: unknown; stderr?: unknown; content?: unknown };
    if ("stdout" in o || "stderr" in o) return [o.stdout, o.stderr].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
    if (typeof o.content === "string") return o.content;
  }
  return JSON.stringify(output) ?? "";
}

/** A command that exited nonzero failed; every other output succeeded. */
const succeeded = (output: unknown): boolean => !(typeof output === "object" && output !== null && typeof (output as { exitCode?: unknown }).exitCode === "number" && (output as { exitCode: number }).exitCode !== 0);

/** `text` after the tool's output: in stdout (a command), in content (a file) or after a string. A
 *  shape with no text of its own (write_file's) is left as it is. */
function appended(output: unknown, text: string): unknown {
  if (typeof output === "string") return `${output}${MARK}${text}`;
  if (typeof output === "object" && output !== null) {
    const o = output as { stdout?: unknown; content?: unknown };
    if (typeof o.stdout === "string") return { ...output, stdout: `${o.stdout}${MARK}${text}` };
    if (typeof o.content === "string") return { ...output, content: `${o.content}${MARK}${text}` };
  }
  return output;
}

/** The runner's answer, when it is the shape we know. */
function reply(value: unknown): { append?: string; stop?: boolean } {
  if (typeof value !== "object" || value === null) return {};
  const { append, stop } = value as { append?: unknown; stop?: unknown };
  return { ...(typeof append === "string" && append !== "" && { append }), ...(stop === true && { stop: true }) };
}

async function report(taps: Taps, body: Record<string, unknown>): Promise<{ append?: string; stop?: boolean }> {
  let timer: unknown;
  try {
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, taps.waitMs ?? WAIT_MS + 500);
    });
    return reply(await Promise.race([taps.send(body), limit]));
  } catch {
    return {};
  } finally {
    clearTimeout(timer as never);
  }
}

/** A redirect a result had no text to carry (write_file's, glob's): it waits here for the next result that has. */
const held = new WeakMap<Taps, string>();

const streams = (value: unknown): boolean => typeof value === "object" && value !== null && Symbol.asyncIterator in value;

/** `execute` of the eve tool `tool`, reporting each finished call. A streaming result (eve allows one
 *  from any tool, none of ours is) is passed through unread. */
// The result type is the tool's own, plain or a stream; the wrapper changes neither, so it is `any` here.
export function withEconomy<I, R, C>(tool: string, execute: (input: I, ctx: C) => R | Promise<R>, taps: Taps = real): (input: I, ctx: C) => any {
  return async (input: I, ctx: C) => {
    if (!taps.enabled()) return await execute(input, ctx);
    let output: R;
    try {
      output = await execute(input, ctx);
    } catch (e) {
      await report(taps, { tool, input, output: (e instanceof Error ? e.message : String(e)).slice(0, OUTPUT_CAP), ok: false });
      throw e;
    }
    if (streams(output)) return output;
    const answer = await report(taps, { tool, input, output: outputText(output).slice(0, OUTPUT_CAP), ok: succeeded(output) });
    const waiting = held.get(taps);
    const text = answer.stop ? ENDING : [waiting, answer.append].filter((part) => part !== undefined).join("\n\n") || undefined;
    if (text === undefined) return output;
    const told = appended(output, text);
    if (told === output && !answer.stop) held.set(taps, text);
    else held.delete(taps);
    return told;
  };
}
