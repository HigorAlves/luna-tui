// The runner's side of the token economy on eve: reports from the tools become the session's calls,
// and an observation finds the call the stream shows settled.
import { describe, expect, it } from "vitest";

import { type EconomySession, economySession } from "../../core/economy/session.ts";
import { EconomyTap } from "./economy.ts";
import { serveLuna, TurnFollower } from "./run.ts";
import { PACKS, type RunEvent } from "@hardness/contracts";

const session = (steps: ("none" | "redirect" | "stop")[]): EconomySession & { seen: { tool: string; input: unknown }[] } => {
  const seen: { tool: string; input: unknown }[] = [];
  return {
    seen,
    settled: (call) => {
      seen.push({ tool: call.tool, input: call.input });
      const kind = steps.shift() ?? "none";
      return { observation: { form: `${call.tool}#${seen.length}` }, step: kind === "redirect" ? { kind, text: "change approach" } : kind === "stop" ? { kind, reason: "LOOP_STUCK: x" } : { kind } };
    },
  };
};

describe("EconomyTap", () => {
  it("reads eve's file tools under the names the observer knows, and answers a redirect", () => {
    const s = session(["redirect"]);
    const tap = new EconomyTap(s, () => {});
    expect(tap.report({ tool: "write_file", input: { filePath: "/w/a.ts", content: "x" }, output: "{}", ok: true })).toEqual({ append: "change approach" });
    expect(s.seen[0]).toMatchObject({ tool: "write", input: { file_path: "/w/a.ts" } });
  });

  it("hands an observation to the call with the same tool and input, else the oldest of the tool", () => {
    const tap = new EconomyTap(session([]), () => {});
    tap.report({ tool: "bash", input: { command: "a" }, output: "", ok: false });
    tap.report({ tool: "bash", input: { command: "b" }, output: "", ok: true });
    expect(tap.take("bash", { command: "b" })).toMatchObject({ observation: { form: "bash#2" }, ok: true });
    expect(tap.take("bash", { command: "zzz" })).toMatchObject({ observation: { form: "bash#1" }, ok: false });
    expect(tap.take("bash", { command: "a" })).toBeUndefined();
  });

  it("keeps every field of a real observation on its way to the settled call, labels, variables and probe included", () => {
    const tap = new EconomyTap(economySession({ economy: {}, work: "/w", emit: () => {} }) as EconomySession, () => {});
    const input = { command: "APP_ENV=test python runtests.py tests.app | tail" };
    tap.report({ tool: "bash", input, output: "FAILED (failures=1)\nModuleNotFoundError: No module named 'tests'", ok: true });
    const taken = tap.take("bash", input);
    expect(taken?.observation).toMatchObject({ intent: "test", labels: ["tests.app"], labelErr: true, sets: { APP_ENV: "test" } });
    expect(taken?.observation.failure).toMatch(/^[0-9a-f]{10}$/);
    const probe = { command: "git remote -v" };
    tap.report({ tool: "bash", input: probe, output: "", ok: true });
    expect(tap.take("bash", probe)?.observation.probe).toBe("empty");
  });

  it("stops once, names the call that ended the run, and reads nothing after", () => {
    const s = session(["stop"]);
    const stops: unknown[] = [];
    const tap = new EconomyTap(s, (reason, call) => stops.push([reason, call]));
    expect(tap.report({ tool: "bash", input: { command: "x" }, output: "", ok: false })).toEqual({ stop: true });
    expect(tap.report({ tool: "bash", input: { command: "y" }, output: "", ok: false })).toEqual({ stop: true });
    expect(stops).toEqual([["LOOP_STUCK: x", { tool: "bash", input: { command: "x" } }]]);
    expect(s.seen).toHaveLength(1);
  });

  it("answers nothing to a report it cannot read", () => {
    expect(new EconomyTap(session([]), () => {}).report({ nope: 1 })).toEqual({});
  });
});

describe("calls the wrappers do not report", () => {
  const stream = (turn: TurnFollower, callId: string, tool: string, input: unknown, outcome = "completed") => {
    turn.take({ type: "call.requested", data: { callId, capability: { name: tool }, input } });
    turn.take({ type: "call.started", data: { callId } });
    return turn.take({ type: "call.settled", data: { callId, outcome } });
  };

  it("gives the session one settled call with no output for a tool nothing wraps, ok from the stream", () => {
    const s = session([]);
    const settled: { tool: string; output: string; ok: boolean }[] = [];
    const spy = { ...s, settled: (c: Parameters<EconomySession["settled"]>[0]) => (settled.push({ tool: c.tool, output: c.output, ok: c.ok }), s.settled(c)) };
    const turn = new TurnFollower(PACKS.implementing, 50, () => {}, "", new EconomyTap(spy, () => {}));
    stream(turn, "c1", "delegate", { helper: "x" });
    stream(turn, "c2", "step", { id: 1 }, "failed");
    expect(settled).toEqual([{ tool: "delegate", output: "", ok: true }, { tool: "step", output: "", ok: false }]);
  });

  it("does not count a wrapped tool twice: its report is the call, and the stream adds nothing", () => {
    const s = session([]);
    const tap = new EconomyTap(s, () => {});
    const turn = new TurnFollower(PACKS.implementing, 50, () => {}, "", tap);
    turn.take({ type: "call.requested", data: { callId: "c1", capability: { name: "bash" }, input: { command: "ls" } } });
    tap.report({ tool: "bash", input: { command: "ls" }, output: "", ok: true });
    turn.take({ type: "call.started", data: { callId: "c1" } });
    turn.take({ type: "call.settled", data: { callId: "c1", outcome: "completed" } });
    expect(s.seen).toHaveLength(1);
  });

  it("counts no call the guard refused", () => {
    const s = session([]);
    const turn = new TurnFollower(PACKS.implementing, 50, () => {}, "", new EconomyTap(s, () => {}));
    stream(turn, "c1", "delegate", {}, "rejected");
    expect(s.seen).toHaveLength(0);
  });

  it("carries a redirect from such a call on the next report's reply, and ends the run on a stop", () => {
    const stops: unknown[] = [];
    const redirecting = new EconomyTap(session(["redirect"]), () => {});
    const turn = new TurnFollower(PACKS.implementing, 50, () => {}, "", redirecting);
    stream(turn, "c1", "delegate", {});
    expect(redirecting.report({ tool: "bash", input: {}, output: "", ok: true })).toEqual({ append: "change approach" });
    expect(redirecting.report({ tool: "bash", input: {}, output: "", ok: true })).toEqual({});

    const stopping = new EconomyTap(session(["stop"]), (reason, call) => (stops.push([reason, call]), turn2.end(call.tool, call.input)));
    const events: RunEvent[] = [];
    const turn2 = new TurnFollower(PACKS.implementing, 50, (e) => events.push(e), "", stopping);
    expect(stream(turn2, "c2", "delegate", { a: 1 })).toBe(true);
    expect(stops).toEqual([["LOOP_STUCK: x", { tool: "delegate", input: { a: 1 } }]]);
  });
});

describe("serveLuna's economy route", () => {
  const post = (url: string, token: string) => fetch(`${url}/economy`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ tool: "bash", input: {}, output: "", ok: true }) });

  it("gives a report to the tap, and nothing to say without one, never to a luna tool", async () => {
    const token = "a".repeat(48);
    const luna: string[] = [];
    const tap = new EconomyTap(session(["redirect"]), () => {});
    const withTap = await serveLuna(async (tool) => (luna.push(tool), {}), token, tap);
    const without = await serveLuna(async (tool) => (luna.push(tool), {}), token);
    try {
      expect(await (await post(withTap.url, token)).json()).toEqual({ append: "change approach" });
      expect(await (await post(without.url, token)).json()).toEqual({});
      expect((await post(withTap.url, "b".repeat(48))).status).toBe(403);
      expect(luna).toEqual([]);
    } finally {
      withTap.server.close();
      without.server.close();
    }
  });
});
