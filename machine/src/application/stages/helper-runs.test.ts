import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineId, type Ledger, type Slice, stepsOfAnswer } from "@hardness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type HelperRunsDeps, helperRuns } from "./helper-runs.ts";
import type { StageContext, StageResult } from "../ports.ts";

const BASE = "a".repeat(40);
const TIP = "b".repeat(40);
const plan: Slice[] = stepsOfAnswer([
  { title: "API", description: "API", est_loc: 20, files: ["src/api/card.ts", "src/api/card.test.ts"], done_when: ["a"] },
  { title: "Card", description: "Card", est_loc: 40, files: ["src/ui/Card.tsx", "src/ui/Card.test.tsx"], done_when: ["shows the title"] },
  { title: "Page", description: "Page", est_loc: 30, files: ["src/ui/Page.tsx", "src/ui/Card.css"], done_when: ["b"] },
]).slices;
const ledger: Ledger = { schema: 1, slices: plan.map((s, i) => ({ id: i + 1, title: s.title, status: "pending" as const, commit: null })) };

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "helper-runs-"));
  await writeFile(join(out, "ledger.json"), JSON.stringify(ledger));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

const stateOf = async (slice: number) => JSON.parse(await readFile(join(out, "checks", `helper-state-${slice}.json`), "utf8"));

/** A helper run the test settles by hand. */
function control() {
  let settle!: (r: StageResult) => void;
  const calls: Array<{ context: StageContext; extra: any }> = [];
  const runHelper = (context: StageContext, extra: any) => (calls.push({ context, extra }), new Promise<StageResult>((resolve) => (settle = resolve)));
  return { runHelper, calls, settle: (r: StageResult) => settle(r) };
}

function setup(over: Partial<HelperRunsDeps> = {}) {
  const rows: Array<{ kind: string; payload: any }> = [];
  const removed: string[] = [];
  const made: unknown[][] = [];
  const taken: unknown[][] = [];
  const c = control();
  let take: Awaited<ReturnType<HelperRunsDeps["takeHelperCommits"]>> = { ok: true, tip: TIP, commits: ["c".repeat(40)] };
  let spent = false;
  const abort = new AbortController();
  const deps: HelperRunsDeps = {
    taskId: "task1",
    cardPath: "/cards/w",
    outDir: out,
    context: { task: { id: "task1" }, stage: "implementing", attempt: 1, runId: "run-9", approvals: [], signal: abort.signal, started: async () => {}, resume: undefined } as unknown as StageContext,
    signal: abort.signal,
    importer: { sync: async () => ({ ok: true as const, head: BASE, changed: false }) },
    facts: async () => ({ slices: plan, webRoots: [], designRef: { refs: [] }, designOff: false, designBudget: { spent, minutesLeft: 30 }, implementerMinutesLeft: 25, implementerEngine: "claude:sonnet" as EngineId, repoEngine: null, claudeAvailable: true }),
    helperWorkspace: {
      make: async (...a) => (made.push(a), { path: `/cards/w.helper-${a[3]}-${a[4]}`, branch: `luna-helper-${a[3]}`, ref: `refs/luna/helper/task1/${a[3]}` }),
      remove: async (path) => void removed.push(path),
    },
    takeHelperCommits: async (...a) => (taken.push(a), take),
    runHelper: c.runHelper,
    emit: async (kind, payload) => void rows.push({ kind, payload }),
    now: (() => { let t = 0; return () => (t += 120_000); })(),
    cancelWaitMs: 50,
    ...over,
  };
  return { deps, rows, removed, made, taken, c, abort, setTake: (t: typeof take) => (take = t), spend: () => (spent = true), coordinator: helperRuns(deps) };
}

const ask = (coordinator: ReturnType<typeof helperRuns>, slice = 2) => coordinator.onHelperRequest({ nonce: "ab12cd34", n: 1, slice, message: "make it match the frame" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("helperRuns: starting a helper", () => {
  it("refuses with the rule's one line and a row, and makes no workspace and starts no run", async () => {
    const t = setup();
    expect(await ask(t.coordinator, 1)).toEqual({ ok: false, error: "slice 1 is not a pure UI slice: a planned file does not render, or is a manifest or a test only; build it yourself" });
    expect(t.rows).toEqual([{ kind: "build.helper_refused", payload: { slice: 1, reason: expect.stringContaining("not a pure UI slice") } }]);
    expect(t.made).toEqual([]);
    expect(t.c.calls).toEqual([]);
  });

  it("refuses a slice number that is not a whole number in the plan, and an importer that cannot take the implementer's commits in", async () => {
    const t = setup();
    expect(await ask(t.coordinator, 1.5)).toMatchObject({ ok: false });
    expect(await ask(t.coordinator, 9)).toEqual({ ok: false, error: "slice 9 is not in the plan" });
    const bad = setup({ importer: { sync: async () => ({ ok: false as const, kind: "bad_bundle" as const, reason: "a bundle did not fetch" }) } });
    expect(await ask(bad.coordinator)).toEqual({ ok: false, error: expect.stringContaining("a bundle did not fetch") });
    expect(bad.c.calls).toEqual([]);
  });

  it("makes the workspace at the imported card tip, writes the state, logs the start and starts the run without waiting for it", async () => {
    const t = setup();
    const answer = await ask(t.coordinator);
    expect(t.made).toEqual([["/cards/w", BASE, "task1", 2, 1]]);
    expect(answer).toEqual({ ok: true, handle: "task1/2", branch: "refs/luna/helper/task1/2", base: BASE, locks: ["src/ui/Card.tsx", "src/ui/Card.test.tsx"] });
    expect(await stateOf(2)).toEqual({ state: "running", attempt: 1 });
    expect(t.rows).toEqual([{ kind: "build.helper_started", payload: { slice: 2, base: BASE, branch: "refs/luna/helper/task1/2", engine: "claude:sonnet", attempt: 1, locks: { helper: ["src/ui/Card.tsx", "src/ui/Card.test.tsx"], implementer: ["src/api/card.ts", "src/api/card.test.ts", "src/ui/Page.tsx", "src/ui/Card.css"] } } }]);
    const [call] = t.c.calls;
    expect(call!.context).toMatchObject({ runId: "run-9-helper-2-1", engine: "claude:sonnet", budgetMinutes: 22, task: { id: "task1" } });
    expect(call!.context.started).toBeUndefined();
    expect(call!.context.signal.aborted).toBe(false);
    expect(call!.extra).toEqual({
      workspace: { path: "/cards/w.helper-2-1", branch: "luna-helper-2" },
      helper: { slice: { id: 2, title: "Card", touchpoints: plan[1]!.touchpoints, acceptance: plan[1]!.acceptance }, message: "make it match the frame", base: BASE, locks: { mine: plan[1]!.touchpoints, theirs: ["src/api/card.ts", "src/api/card.test.ts", "src/ui/Page.tsx", "src/ui/Card.css"] }, attempt: 1 },
    });
  });

  it("refuses a second request while one helper runs, and the same slice again after it ended", async () => {
    const t = setup();
    await ask(t.coordinator);
    expect(await ask(t.coordinator, 3)).toEqual({ ok: false, error: "the ui-designer is already building slice 2; call slice_wait, then delegate again" });
    t.c.settle({ outcome: "fail", detail: { error: "boom" } });
    await tick();
    expect(await ask(t.coordinator)).toEqual({ ok: false, error: "the ui-designer already had slice 2 once: build it yourself" });
  });

  it("answers an error and leaves nothing behind when the workspace cannot be made", async () => {
    const t = setup({ helperWorkspace: { make: async () => { throw new Error("disk full"); }, remove: async () => {} } });
    expect(await ask(t.coordinator)).toEqual({ ok: false, error: expect.stringContaining("disk full") });
    expect(t.rows.map((r) => r.kind)).toEqual(["build.helper_refused"]);
    expect(t.c.calls).toEqual([]);
    expect(t.coordinator.delegatedLocks()).toEqual([]);
  });
});

describe("helperRuns: following the helper", () => {
  it("takes the commits of a pass and goes to returned, logging how it ended; its files stay locked until it is picked", async () => {
    const t = setup();
    await ask(t.coordinator);
    expect(t.coordinator.delegatedLocks()).toEqual(["src/ui/Card.tsx", "src/ui/Card.test.tsx"]);
    t.c.settle({ outcome: "pass", usage: { turns: 4, costUsd: null, tokens: { input: 300_000, output: 20_000 } } as never });
    await tick();
    expect(t.taken).toEqual([["/cards/w", "/cards/w.helper-2-1", "task1", 2, BASE, { locked: ["src/api/card.ts", "src/api/card.test.ts", "src/ui/Page.tsx", "src/ui/Card.css"], allowed: plan[1]!.touchpoints, protectedPaths: [] }]]);
    expect(await stateOf(2)).toMatchObject({ state: "returned", attempt: 1 });
    expect(t.rows.map((r) => r.kind)).toEqual(["build.helper_started", "build.helper_ended"]);
    expect(t.rows[1]!.payload).toEqual({ slice: 2, attempt: 1, outcome: "pass", tokens: 320_000, minutes: 2 });
    expect(t.coordinator.delegatedLocks()).toEqual(["src/ui/Card.tsx", "src/ui/Card.test.tsx"]);
    expect(t.removed).toEqual([]);
  });

  it("goes to failed on a fail, a timeout or an escalation, with the reason in a line, frees the files and the workspace", async () => {
    const t = setup();
    await ask(t.coordinator);
    t.c.settle({ outcome: "escalated", detail: { reason: "the frame is\nnot there  ".repeat(60) } });
    await tick();
    const state = await stateOf(2);
    expect(state).toMatchObject({ state: "failed", attempt: 1 });
    expect(state.summary).toContain("the frame is not there");
    expect(state.summary).not.toContain("\n");
    expect(state.summary.length).toBeLessThanOrEqual(300);
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_ended", payload: expect.objectContaining({ slice: 2, outcome: "escalated", tokens: null }) });
    expect(t.coordinator.delegatedLocks()).toEqual([]);
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
    expect(t.taken).toEqual([]);
  });

  it("goes to failed when the run throws", async () => {
    const t = setup({ runHelper: async () => { throw new Error("container did not start"); } });
    await ask(t.coordinator);
    await tick();
    expect(await stateOf(2)).toMatchObject({ state: "failed", summary: expect.stringContaining("container did not start") });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
  });

  it("applies D4 when the helper touched the implementer's locked files: refused, with a refusal row, the files and workspace freed", async () => {
    const t = setup();
    t.setTake({ ok: false, reason: "locked_file", detail: "touches src/api/card.ts", files: ["src/api/card.ts"] });
    await ask(t.coordinator);
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await stateOf(2)).toMatchObject({ state: "refused", summary: expect.stringContaining("src/api/card.ts") });
    expect(t.rows.map((r) => r.kind)).toEqual(["build.helper_started", "build.helper_ended", "build.helper_refused"]);
    expect(t.rows.at(-1)!.payload).toEqual({ slice: 2, reason: expect.stringContaining("src/api/card.ts") });
    expect(t.coordinator.delegatedLocks()).toEqual([]);
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
  });

  it("takes the helper's commits against the implementer's locks, the slice's planned files and the protected test paths", async () => {
    const t = setup({ facts: async () => ({ ...(await setup().deps.facts()), protectedPaths: ["src/ui/Card.scenario.test.ts"] }) });
    await ask(t.coordinator);
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(t.taken[0]!.at(-1)).toEqual({ locked: ["src/api/card.ts", "src/api/card.test.ts", "src/ui/Page.tsx", "src/ui/Card.css"], allowed: plan[1]!.touchpoints, protectedPaths: ["src/ui/Card.scenario.test.ts"] });
  });

  it("treats a take that went outside the slice like a locked file (D4): refused, a refusal row, the workspace freed", async () => {
    const t = setup();
    t.setTake({ ok: false, reason: "out_of_slice", detail: "touches 1 file outside its slice", files: ["package.json"] });
    await ask(t.coordinator);
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await stateOf(2)).toMatchObject({ state: "refused", summary: expect.stringContaining("package.json") });
    expect(t.rows.map((r) => r.kind)).toEqual(["build.helper_started", "build.helper_ended", "build.helper_refused"]);
    expect(t.coordinator.delegatedLocks()).toEqual([]);
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
  });

  it("goes to failed, not refused, when the commits cannot be taken for another reason", async () => {
    const t = setup();
    t.setTake({ ok: false, reason: "merge_commit", detail: "a merge commit" });
    await ask(t.coordinator);
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await stateOf(2)).toMatchObject({ state: "failed", summary: expect.stringContaining("merge commit") });
    expect(t.rows.map((r) => r.kind)).toEqual(["build.helper_started", "build.helper_ended"]);
  });

  it("is told the design budget is spent when the helper's own run spent it, and the run's end carries that as an escalation", async () => {
    const t = setup();
    await ask(t.coordinator);
    t.spend();
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await t.coordinator.afterRun("pass")).toEqual({ escalate: "design_budget", reason: expect.stringContaining("design budget") });
  });
});

describe("helperRuns: cancelling", () => {
  it("aborts the helper, waits for it, records cancelled and removes the workspace", async () => {
    const t = setup();
    await ask(t.coordinator);
    const signal = t.c.calls[0]!.context.signal;
    const done = t.coordinator.cancel();
    expect(signal.aborted).toBe(true);
    t.c.settle({ outcome: "fail", detail: { error: "aborted" } });
    await done;
    expect(await stateOf(2)).toMatchObject({ state: "cancelled" });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
    expect(t.coordinator.delegatedLocks()).toEqual([]);
    expect(t.taken).toEqual([]);
  });

  it("stops waiting after cancelWaitMs for a run that never settles, and still frees everything", async () => {
    const t = setup();
    await ask(t.coordinator);
    await t.coordinator.cancel();
    expect(await stateOf(2)).toMatchObject({ state: "cancelled" });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
  });

  it("aborts the helper when the implementer's own signal aborts", async () => {
    const t = setup();
    await ask(t.coordinator);
    t.abort.abort();
    expect(t.c.calls[0]!.context.signal.aborted).toBe(true);
  });

  it("does nothing with no helper", async () => {
    const t = setup();
    await expect(t.coordinator.cancel()).resolves.toBeUndefined();
    expect(t.removed).toEqual([]);
  });
});

describe("helperRuns: the end of the implementer's run", () => {
  it("cancels a running helper after a fail, a timeout or an escalation, and says nothing", async () => {
    for (const outcome of ["fail", "escalated"] as const) {
      const t = setup();
      await ask(t.coordinator);
      expect(await t.coordinator.afterRun(outcome)).toBeNull();
      expect(t.c.calls[0]!.context.signal.aborted).toBe(true);
      expect(await stateOf(2)).toMatchObject({ state: "cancelled" });
    }
  });

  it("has nothing to say with no helper", async () => {
    expect(await setup().coordinator.afterRun("pass")).toBeNull();
  });
});

describe("helperRuns: what slice 78 builds on", () => {
  it("answers a pick request and an ack with a plain refusal until the pick is built", async () => {
    const t = setup();
    expect(await t.coordinator.onPickRequest({ nonce: "ab12cd34", n: 2, slice: 2, head: BASE })).toMatchObject({ ok: false });
    expect(await t.coordinator.onPickAck({ nonce: "ab12cd34", n: 3, slice: 2, head: TIP })).toMatchObject({ ok: false });
  });

  it("holds the shas picked on earlier runs of the card, readable while the run goes", () => {
    const t = setup({ priorPicked: ["d".repeat(40)] });
    expect([...t.coordinator.picked()]).toEqual(["d".repeat(40)]);
  });
});
