// The readable transcript on stdout, made from the run's events: the board's watch pane follows it
// with `docker logs -f`, and the machine's stuck detector counts its `→ <Tool> <target>` lines. A
// runtime never writes a line itself; it emits events (core/events.ts) and this prints them.
import type { RunEvent } from "@hardness/contracts";

/** A tool call's line: `→ <Tool> <target>`, and ` ·<fingerprint>` for an edit or a write. */
export const callText = (tool: string, target: string, fingerprint?: string): string => `→ ${tool} ${target}`.trimEnd() + (fingerprint ? ` ·${fingerprint}` : "");

/** The line one event prints, or null for an event the transcript does not show. A failed call
 *  prints only when its runtime said why. */
export function transcriptLine(event: RunEvent): string | null {
  switch (event.kind) {
    case "session":
    case "text":
      return event.payload.text;
    case "tool_call":
      return callText(event.payload.tool, event.payload.target, event.payload.fingerprint);
    case "tool_result":
      return !event.payload.ok && event.payload.error !== undefined ? `  ✗ ${event.payload.tool} ${event.payload.error}`.trimEnd() : null;
    case "step":
      return `· ${event.payload.label}${event.payload.of ? ` (${event.payload.n}/${event.payload.of})` : ""}`;
    default:
      return null;
  }
}

/** Prints each event's line, if it has one, through `out`. */
export const transcript =
  (out: (line: string) => void) =>
  (event: RunEvent): void => {
    const line = transcriptLine(event);
    if (line !== null) out(line);
  };
