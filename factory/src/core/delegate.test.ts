// The delegate tool apart from any runtime: which helpers it serves, what it refuses before a child
// starts, and the budget a child gets. The table (runtimes/conformance/) runs it through each runtime.
import { PACKS, type RunEvent, StageInput } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { delegatedHelpers, delegation, delegationFor, missingCredential, withChildren, withDelegate } from "./delegate.ts";
import { EMPTY_RUN } from "./output.ts";
import type { RunContext, Runtime } from "./runtime.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = { role: "security-reviewer", engine: "codex:sol" } as const;
const PACK = { ...PACKS.verifying, helpers: [HELPER] };

const input = (limits = { maxTurns: 40, timeoutMs: 20 * 60_000 }) =>
  StageInput.parse({
    schema: 3,
    stage: "verifying",
    pack: "verifying",
    attempt: 1,
    task: { id: "t1", title: "t", description: "", criteria: [], repoPath: "/r", branch: "task/t1", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null },
    limits,
    env: {},
  });

let root: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delegate-"));
  codexHome = join(root, "codex");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "auth.json"), "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A helper runtime that answers and keeps what it was given. */
const answering = (given: RunContext[]): Runtime => ({
  id: "eve",
  sdk: "eve",
  instructions: () => ({ role: "", rules: "", skills: [] }),
  run: async (ctx) => {
    given.push(ctx);
    return { ...EMPTY_RUN, ok: true, structured: { answer: `ok ${given.length}` }, turns: 3, costUsd: 0.5 };
  },
});

function delegating(over: { limits?: { maxTurns: number; timeoutMs: number }; turnsUsed?: number; startedAt?: number; env?: NodeJS.ProcessEnv } = {}) {
  const given: RunContext[] = [];
  const events: RunEvent[] = [];
  const d = delegation({
    pack: PACK,
    helpers: [HELPER],
    input: input(over.limits),
    paths: { factoryRoot: FACTORY_ROOT, work: root, out: join(root, "out"), input: root },
    runtimes: { eve: answering(given) },
    emit: (e) => events.push(e),
    env: over.env ?? { CODEX_HOME: codexHome },
    startedAt: over.startedAt ?? Date.now(),
    turnsUsed: () => over.turnsUsed ?? 0,
  });
  return { d, given, events };
}

describe("delegate", () => {
  it("serves on Claude only the helpers on another runtime, elsewhere every helper, and nothing for a pack without one", () => {
    const pack = { ...PACKS.reviewing, helpers: [...PACKS.reviewing.helpers, HELPER] };
    expect(delegatedHelpers(pack, "claude")).toEqual([HELPER]);
    expect(delegatedHelpers(pack, "eve")).toEqual(pack.helpers);
    expect(delegatedHelpers(PACKS.reviewing, "claude")).toEqual([]);
    expect(delegatedHelpers(PACKS.triage_signals, "jev")).toEqual([]);
    const options = { input: input(), paths: { factoryRoot: FACTORY_ROOT, work: root, out: root, input: root }, runtimes: {}, emit: () => {}, startedAt: 0, turnsUsed: () => 0 };
    expect(delegationFor("claude", { ...options, pack: PACKS.reviewing })).toBeNull();
    expect(delegationFor("claude", { ...options, pack })?.tool.description).toMatch(/- security-reviewer \(codex:sol\): Reviews a diff/);
  });

  it("finds an engine's credential in the container the way its runtime would", () => {
    expect(missingCredential("codex:sol", { CODEX_HOME: codexHome })).toBeNull();
    expect(missingCredential("codex:sol", { CODEX_HOME: join(root, "nowhere") })).toBe("no Codex login in this stage");
    expect(missingCredential("claude:opus", { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBeNull();
    expect(missingCredential("claude:opus", {})).toBe("no Claude credential in this stage");
    expect(missingCredential("openai:sol", {})).toBe("no OpenAI key in this stage");
  });

  it("runs each call as the next child, in its own folder, within what the parent has left", async () => {
    const { d, given, events } = delegating({ turnsUsed: 30 });
    expect(await d.call({ helper: HELPER.role, message: "first" })).toEqual({ answer: "ok 1" });
    expect(await d.call({ helper: HELPER.role, message: "second" })).toEqual({ answer: "ok 2" });
    // 40 turns, 30 used: the first child gets 9 (one is the parent's to answer), the second 6.
    expect(given.map((c) => c.input.limits.maxTurns)).toEqual([9, 6]);
    expect(given[0]!.input.limits.timeoutMs).toBe(10 * 60_000);
    expect(given.map((c) => c.paths.out)).toEqual([join(root, "out", "children", "1"), join(root, "out", "children", "2")]);
    expect(readFileSync(join(root, "out", "children", "2", "prompt.md"), "utf8")).toContain("second");
    expect(events.map((e) => (e.kind === "child" ? `${e.payload.phase} ${e.payload.runId}` : e.kind))).toEqual(["start child-1", "end child-1", "start child-2", "end child-2"]);
    expect(d.spent).toEqual({ costUsd: 1, turns: 6 });
    expect(withChildren({ ...EMPTY_RUN, costUsd: 2 }, d).costUsd).toBe(3);
    expect(withChildren({ ...EMPTY_RUN, costUsd: null }, d).costUsd).toBe(1);
  });

  it("starts no child without the turns or the time for one, or for a helper the pack does not have", async () => {
    expect(await delegating({ turnsUsed: 38 }).d.call({ helper: HELPER.role, message: "m" })).toEqual({ error: expect.stringMatching(/gave no answer: the stage has 2 turns left, not enough for a helper/) });
    const late = delegating({ limits: { maxTurns: 40, timeoutMs: 5 * 60_000 }, startedAt: Date.now() - 4 * 60_000 });
    expect(await late.d.call({ helper: HELPER.role, message: "m" })).toEqual({ error: expect.stringMatching(/s left, not enough for a helper/) });
    expect(late.given).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "out", "children", "1", "result.json"), "utf8"))).toMatchObject({ ok: false, error: expect.stringMatching(/not enough/) });
    expect(await delegating().d.call({ helper: "reply-drafter", message: "m" })).toEqual({ error: expect.stringMatching(/^helper: /) });
    expect(await delegating().d.call({ helper: HELPER.role, message: "" })).toEqual({ error: expect.stringMatching(/^message: /) });
  });

  it("routes only `delegate` to the delegation", async () => {
    const calls: string[] = [];
    const luna = { call: async (tool: string) => calls.push(tool) };
    const { d } = delegating();
    const both = withDelegate(luna, d);
    await both.call("step", {});
    expect(await both.call("delegate", { helper: HELPER.role, message: "m" })).toEqual({ answer: "ok 1" });
    expect(calls).toEqual(["step"]);
    expect(withDelegate(luna, null)).toBe(luna);
  });
});
