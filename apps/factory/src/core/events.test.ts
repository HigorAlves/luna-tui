import type { RunEvent } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { CallJoin } from "./events.ts";

const DENY = { allow: false as const, reason: "git push is not allowed" };
const ALLOW = { allow: true as const };

function join() {
  const events: RunEvent[] = [];
  const calls = new CallJoin((e) => events.push(e), (tool) => tool === "Bash");
  return { events, calls };
}

describe("CallJoin", () => {
  it("emits a guarded call once its guard decided, refused with the reason", () => {
    const { events, calls } = join();
    calls.requested("1", "Bash", { command: "git push origin HEAD" });
    expect(events).toEqual([]);
    calls.decided("1", "Bash", { command: "git push origin HEAD" }, DENY);
    expect(events).toEqual([{ kind: "tool_call", payload: { id: "1", tool: "Bash", target: "git push origin HEAD", allowed: false, reason: DENY.reason } }]);
  });

  it("emits a call whose guard decided before the stream showed it when the stream does", () => {
    const { events, calls } = join();
    calls.decided("1", "Bash", { command: "pwd" }, ALLOW);
    expect(events).toEqual([]);
    calls.requested("1", "Bash", { command: "pwd" });
    expect(events).toEqual([{ kind: "tool_call", payload: { id: "1", tool: "Bash", target: "pwd", allowed: true } }]);
  });

  it("emits a call no guard looks at as soon as it is requested, allowed", () => {
    const { events, calls } = join();
    calls.requested("2", "mcp__luna__step", { label: "reading" });
    expect(events).toEqual([{ kind: "tool_call", payload: { id: "2", tool: "mcp__luna__step", target: "reading", allowed: true } }]);
  });

  it("carries an edit's fingerprint", () => {
    const { events, calls } = join();
    calls.requested("3", "Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" });
    expect(events[0]).toMatchObject({ payload: { tool: "Edit", target: "/work/a.ts", fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) } });
  });

  it("settles a call with its result, after the call itself, once", () => {
    const { events, calls } = join();
    calls.requested("1", "Bash", { command: "ls" });
    calls.settled("1", false, "failed: exit 2");
    calls.decided("1", "Bash", { command: "ls" }, ALLOW);
    expect(events).toEqual([
      { kind: "tool_call", payload: { id: "1", tool: "Bash", target: "ls", allowed: true } },
      { kind: "tool_result", payload: { id: "1", tool: "Bash", ok: false, error: "failed: exit 2" } },
    ]);
  });

  it("names a result it never saw the call of `call`", () => {
    const { events, calls } = join();
    calls.settled("9", true);
    expect(events).toEqual([{ kind: "tool_result", payload: { id: "9", tool: "call", ok: true } }]);
  });

  it("flushes what is left at the end: a requested call as allowed, a decision the stream never showed as decided", () => {
    const { events, calls } = join();
    calls.requested("1", "Bash", { command: "ls" });
    calls.decided("2", "Bash", { command: "rm -rf /" }, DENY);
    calls.flush();
    calls.flush();
    expect(events).toEqual([
      { kind: "tool_call", payload: { id: "1", tool: "Bash", target: "ls", allowed: true } },
      { kind: "tool_call", payload: { id: "2", tool: "Bash", target: "rm -rf /", allowed: false, reason: DENY.reason } },
    ]);
  });
});

describe("CallJoin denials", () => {
  const REASON = "Permission to use Bash has been denied because Claude Code is running in don't ask mode";

  it("records a call the runtime refused after the guard let it pass as refused, with the reason, and puts the reason on its result", () => {
    const { events, calls } = join();
    calls.requested("1", "Bash", { command: "git -C /work status" });
    calls.denied("1", REASON);
    calls.settled("1", false);
    expect(events).toEqual([
      { kind: "tool_call", payload: { id: "1", tool: "Bash", target: "git -C /work status", allowed: false, reason: REASON } },
      { kind: "tool_result", payload: { id: "1", tool: "Bash", ok: false, error: REASON } },
    ]);
  });

  it("overrides a guard's allow that arrives after the denial, and keeps the guard's own reason when it refused", () => {
    const { events, calls } = join();
    calls.denied("1", REASON);
    calls.decided("1", "Bash", { command: "ls" }, ALLOW);
    calls.requested("1", "Bash", { command: "ls" });
    calls.requested("2", "Bash", { command: "rm -rf /" });
    calls.decided("2", "Bash", { command: "rm -rf /" }, DENY);
    calls.denied("2", REASON);
    expect(events).toEqual([
      { kind: "tool_call", payload: { id: "1", tool: "Bash", target: "ls", allowed: false, reason: REASON } },
      { kind: "tool_call", payload: { id: "2", tool: "Bash", target: "rm -rf /", allowed: false, reason: DENY.reason } },
    ]);
  });

  it("gives a result the text the stream gave it before the denial's", () => {
    const { events, calls } = join();
    calls.requested("1", "Bash", { command: "ls" });
    calls.denied("1", "other");
    calls.settled("1", false, "the tool's own error");
    expect(events.at(-1)).toMatchObject({ payload: { error: "the tool's own error" } });
  });
});

describe("CallJoin observations", () => {
  const OBSERVATION = { intent: "test" as const, failure: "abcdef0123" };

  it("puts the observation of a call on its result, once", () => {
    const { events, calls } = join();
    calls.requested("1", "Mcp", {});
    calls.observed("1", OBSERVATION);
    calls.settled("1", false);
    expect(events.at(-1)).toEqual({ kind: "tool_result", payload: { id: "1", tool: "Mcp", ok: false, observation: OBSERVATION } });
    calls.settled("1", false);
    expect(events.at(-1)).toEqual({ kind: "tool_result", payload: { id: "1", tool: "Mcp", ok: false } });
  });

  it("leaves a result with no observation as it was", () => {
    const { events, calls } = join();
    calls.requested("1", "Mcp", {});
    calls.settled("1", true);
    expect(events.at(-1)).toEqual({ kind: "tool_result", payload: { id: "1", tool: "Mcp", ok: true } });
  });
});
