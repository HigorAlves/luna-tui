// The runner's side of a native subagent apart from any server: a fake parent session hands out
// a fake child stream, and the tests play what eve would say on it.
import { PACKS, type RunEvent, StageInput } from "@hardness/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ChildStream, type ParentSession, SubagentChildren } from "./children.ts";
import type { SessionEvent } from "./follower.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OPENED: SessionEvent = { type: "child.opened", data: {} };

const input = (limits = { maxTurns: 40, timeoutMs: 20 * 60_000 }) =>
  StageInput.parse({
    schema: 3,
    stage: "triage",
    pack: "triage",
    attempt: 1,
    task: { id: "t1", title: "t", description: "", criteria: [], repoPath: "/r", branch: "task/t1", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null },
    limits,
    env: {},
  });

/** A child stream the test pushes events into; it ends when closed or aborted. */
function channel() {
  const queue: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const poke = () => {
    wake?.();
    wake = null;
  };
  return {
    push(...events: SessionEvent[]) {
      queue.push(...events);
      poke();
    },
    close() {
      done = true;
      poke();
    },
    iterable(signal?: AbortSignal): AsyncIterable<SessionEvent> {
      signal?.addEventListener("abort", () => this.close());
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length > 0) yield queue.shift()!;
            else if (done) return;
            else await new Promise<void>((r) => (wake = r));
          }
        },
      };
    },
  };
}

const modelCall = (n: number): SessionEvent => ({ type: "model.requested", data: { owner: { turnId: "t" }, runId: `r${n}` } });
const answer = (value: unknown): SessionEvent[] => [{ type: "content.completed", data: { kind: "result", value } }, { type: "turn.settled", data: { outcome: "completed" } }];

let root: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "children-"));
  codexHome = join(root, "codex");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "auth.json"), "{}");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function setup(over: { limits?: { maxTurns: number; timeoutMs: number }; turnsUsed?: number; env?: NodeJS.ProcessEnv } = {}) {
  const events: RunEvent[] = [];
  const streams: Array<ReturnType<typeof channel>> = [];
  const cancelled: string[] = [];
  const session: ParentSession = {
    agent: () => {
      const stream = channel();
      streams.push(stream);
      const handle: ChildStream = { id: `child-session-${streams.length}`, stream: (options) => stream.iterable(options?.signal) };
      return handle;
    },
    // eve ends a cancelled turn with a settled event.
    cancelChild: async (id) => {
      cancelled.push(id);
      streams.at(-1)!.push({ type: "turn.settled", data: { outcome: "cancelled" } });
    },
  };
  const children = new SubagentChildren({
    pack: PACKS.triage,
    input: input(over.limits),
    paths: { factoryRoot: FACTORY_ROOT, work: root, out: join(root, "out"), input: root },
    emit: (e) => events.push(e),
    env: over.env ?? { CODEX_HOME: codexHome },
    startedAt: Date.now(),
    turnsUsed: () => over.turnsUsed ?? 0,
  });
  const ends = () => events.filter((e) => e.kind === "child" && e.payload.phase === "end");
  const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));
  return { children, session, events, streams, cancelled, ends, until };
}
const START = { helper: "reply-drafter", message: "Draft the answer" };
const folder = (n: number) => join(root, "out", "children", String(n));

describe("SubagentChildren", () => {
  it("starts a child with the helper's prompt, follows it to its answer and writes its folder", async () => {
    const { children, session, events, streams, ends, until } = setup();
    const started = await children.start(START);
    expect(started).toEqual({ prompt: expect.stringContaining("Draft the answer") });
    expect(readFileSync(join(folder(1), "prompt.md"), "utf8")).toBe((started as { prompt: string }).prompt);
    const ids = { runId: "child-1", pack: "triage", role: "reply-drafter", engine: "codex:luna" };
    expect(events).toEqual([{ kind: "child", payload: { phase: "start", ...ids } }]);

    children.take(OPENED, session);
    streams[0]!.push(modelCall(1), { type: "usage.recorded", data: { usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 5 } } }, ...answer({ answer: "Use the export button." }));
    await until(() => ends().length === 1);
    expect(ends()[0]).toEqual({ kind: "child", payload: { phase: "end", ...ids, ok: true, costUsd: 0.25 } });
    const result = JSON.parse(readFileSync(join(folder(1), "result.json"), "utf8"));
    expect(result).toMatchObject({ ok: true, answer: { answer: "Use the export button." }, usage: { turns: 1, costUsd: 0.25 } });
    expect(readFileSync(join(folder(1), "events.jsonl"), "utf8")).toContain('"kind":"usage"');
    expect(children.spent).toEqual({ costUsd: 0.25, turns: 1 });
  });

  it("cancels the child, not the parent, at its turn cap, and says it ended without an answer", async () => {
    // 5 turns for the stage: the child gets 4 (one is left to the parent).
    const { children, session, streams, cancelled, ends, until } = setup({ limits: { maxTurns: 5, timeoutMs: 20 * 60_000 } });
    await children.start(START);
    children.take(OPENED, session);
    streams[0]!.push(modelCall(1), modelCall(2), modelCall(3), modelCall(4));
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled).toEqual([]);
    streams[0]!.push(modelCall(5));
    await until(() => ends().length === 1);
    expect(cancelled).toEqual(["child-session-1"]);
    expect(ends()[0]!.payload).toMatchObject({ phase: "end", ok: false, error: expect.stringMatching(/within 4 model calls/) });
    expect(JSON.parse(readFileSync(join(folder(1), "result.json"), "utf8"))).toMatchObject({ ok: false });
    expect(children.spent.turns).toBe(5);
  });

  it("cancels the child at its time limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { children, session, streams, cancelled, ends } = setup({ limits: { maxTurns: 40, timeoutMs: 120_000 } });
    await children.start(START);
    children.take(OPENED, session);
    streams[0]!.push(modelCall(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancelled).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancelled).toEqual(["child-session-1"]);
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.payload).toMatchObject({ ok: false, error: expect.stringMatching(/time ran out/) });
  });

  it("refuses a child whose credential is missing: nothing starts and no folder is written", async () => {
    const { children, events } = setup({ env: {} });
    expect(await children.start(START)).toEqual({ error: expect.stringMatching(/gave no answer: no Codex login in this stage/) });
    expect(events).toEqual([]);
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("refuses a child the parent has too few turns left for: nothing starts and no folder is written", async () => {
    const { children, events } = setup({ turnsUsed: 39 });
    expect(await children.start(START)).toEqual({ error: expect.stringMatching(/not enough for a helper/) });
    expect(events).toEqual([]);
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("refuses a helper the stage does not have, and an empty message", async () => {
    const { children } = setup();
    expect(await children.start({ helper: "security-reviewer", message: "x" })).toEqual({ error: expect.stringMatching(/not a helper of this stage/) });
    expect(await children.start({ helper: "reply-drafter", message: "" })).toEqual({ error: expect.stringMatching(/message/) });
  });

  it("runs children one at a time, the second waiting for the first to end and taking what it left", async () => {
    const { children, session, streams, ends, until } = setup({ limits: { maxTurns: 8, timeoutMs: 20 * 60_000 } });
    await children.start(START);
    let second: { prompt: string } | { error: string } | null = null;
    const pending = children.start({ helper: "reply-drafter", message: "Draft the second" }).then((r) => (second = r));
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBeNull();
    expect(existsSync(folder(2))).toBe(false);

    children.take(OPENED, session);
    streams[0]!.push(modelCall(1), modelCall(2), modelCall(3), ...answer({ answer: "first" }));
    await until(() => ends().length === 1);
    await pending;
    expect(second).toEqual({ prompt: expect.stringContaining("Draft the second") });
    expect(readFileSync(join(folder(2), "prompt.md"), "utf8")).toContain("Draft the second");
    // 8 turns, 3 spent by the first and one kept for the parent: 4 left, so a cap of 4.
    children.take(OPENED, session);
    streams[1]!.push(modelCall(1), modelCall(2), modelCall(3), modelCall(4), modelCall(5));
    await until(() => ends().length === 2);
    expect(ends()[1]!.payload).toMatchObject({ runId: "child-2", error: expect.stringMatching(/within 4 model calls/) });
    expect(children.spent.turns).toBe(8);
  });

  it("cancels a child still running when the parent ends, and ends one that never opened", async () => {
    const running = setup();
    await running.children.start(START);
    running.children.take(OPENED, running.session);
    running.streams[0]!.push(modelCall(1));
    await running.children.close();
    expect(running.cancelled).toEqual(["child-session-1"]);
    expect(running.ends()).toHaveLength(1);
    expect(existsSync(join(folder(1), "result.json"))).toBe(true);

    const never = setup();
    await never.children.start(START);
    await never.children.close();
    expect(never.ends()[0]!.payload).toMatchObject({ ok: false, error: expect.stringMatching(/before the helper started/) });
    expect(await never.children.start(START)).toEqual({ error: expect.stringMatching(/ending/) });
  });
});
