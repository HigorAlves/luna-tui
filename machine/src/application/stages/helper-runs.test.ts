import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineId, type Ledger, type Slice, stepsOfAnswer } from "@hardness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HELPER_START_LIMIT_MS, type HelperRunsDeps, helperRuns } from "./helper-runs.ts";
import type { StageContext, StageResult } from "../ports.ts";

const BASE = "a".repeat(40);
const TIP = "b".repeat(40);
const PICKED = "e".repeat(40);
const COMMIT = "c".repeat(40);
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
  let head = BASE;
  let pick: Awaited<ReturnType<HelperRunsDeps["git"]["pickOnto"]>> = { ok: true, picked: [PICKED], tip: PICKED };
  let advance: Awaited<ReturnType<HelperRunsDeps["git"]["advanceBranch"]>> = { ok: true };
  let land: Awaited<ReturnType<HelperRunsDeps["git"]["landInWorktree"]>> = { ok: true };
  let hold: Promise<void> = Promise.resolve();
  let descends = false;
  const calls: unknown[][] = [];
  const log: string[] = [];
  const abort = new AbortController();
  const deps: HelperRunsDeps = {
    taskId: "task1",
    cardPath: "/cards/w",
    outDir: out,
    context: { task: { id: "task1" }, stage: "implementing", attempt: 1, runId: "run-9", approvals: [], signal: abort.signal, started: async () => {}, resume: undefined } as unknown as StageContext,
    signal: abort.signal,
    importer: { sync: async () => (log.push("sync"), { ok: true as const, head, changed: false }) },
    branch: "luna/card",
    identity: { name: "Luna Machine", email: "machine@luna.test" },
    git: {
      pickOnto: async (...a) => (calls.push(["pickOnto", ...a]), pick),
      pickBundle: async (...a) => (calls.push(["pickBundle", ...a]), await writeFile(a[3], "bundle bytes"), { ok: true as const }),
      advanceBranch: async (...a) => (log.push("advance"), calls.push(["advanceBranch", ...a]), await hold, advance),
      landInWorktree: async (...a) => (calls.push(["landInWorktree", ...a]), land),
      isAncestor: async (_card, a, b) => a === b || descends,
      dropHelperRefs: async (...a) => void calls.push(["dropHelperRefs", ...a]),
    },
    publish: async () => (calls.push(["publish"]), { ok: true as const }),
    note: async (text) => void calls.push(["note", text]),
    facts: async () => ({ slices: plan, webRoots: [], designRef: { refs: [] }, designOff: false, designBudget: { spent, minutesLeft: 30 }, implementerMinutesLeft: 25, implementerEngine: "claude:sonnet" as EngineId, repoEngine: null, claudeAvailable: true }),
    helperWorkspace: {
      make: async (...a) => (made.push(a), { path: `/cards/w.helper-${a[3]}-${a[4]}`, branch: `luna-helper-${a[3]}`, ref: `refs/luna/helper/task1/${a[3]}` }),
      remove: async (path) => void removed.push(path),
    },
    takeHelperCommits: async (...a) => (taken.push(a), take),
    runHelper: c.runHelper,
    runExtra: () => ({}),
    emit: async (kind, payload) => void rows.push({ kind, payload }),
    now: (() => { let t = 0; return () => (t += 120_000); })(),
    cancelWaitMs: 50,
    ...over,
  };
  return {
    deps, rows, removed, made, taken, c, abort, calls, log,
    setTake: (t: typeof take) => (take = t), spend: () => (spent = true),
    setDescends: (d: boolean) => (descends = d),
    setHead: (h: string) => (head = h), setPick: (p: typeof pick) => (pick = p), setAdvance: (a: typeof advance) => (advance = a), setLand: (l: typeof land) => (land = l),
    holdAdvance: () => { let release!: () => void; hold = new Promise<void>((r) => (release = r)); return () => { release(); hold = Promise.resolve(); }; },
    coordinator: helperRuns(deps),
  };
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

  it("hands each helper run the implementer's design, scenario tests, tests-commit files and inline tests", async () => {
    const carried = { design: { refs: [] }, scenarioTests: [{ scenario: "S1", file: "a.test.ts" }], testsFiles: ["a.test.ts"], inlineTests: ["lib.rs"] };
    const t = setup({ runExtra: () => carried });
    await ask(t.coordinator);
    expect(t.c.calls[0]!.extra).toMatchObject(carried);
  });

  it("reports the latest helper's state and, once landed, the shas the machine picked for it", async () => {
    const none = setup();
    expect(none.coordinator.status()).toBeNull();
    const t = await returned();
    expect(t.coordinator.status()).toEqual({ slice: 2, state: "returned", attempt: 1 });
    await pickReq(t);
    await ackReq(t);
    expect(t.coordinator.status()).toEqual({ slice: 2, state: "committed", attempt: 1, picked: [PICKED] });
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

describe("helperRuns: a start that comes too late for the factory (L8-5)", () => {
  const slowMake = (clock: { t: number }, took: number): HelperRunsDeps["helperWorkspace"] => ({
    make: async (...a: unknown[]) => ((clock.t += took), { path: `/cards/w.helper-${a[3]}-${a[4]}`, branch: `luna-helper-${a[3]}`, ref: `refs/luna/helper/task1/${a[3]}` }),
    remove: async () => {},
  });

  it("gives a slow clone up: the workspace is removed, no run starts, the answer is ok:false", async () => {
    const clock = { t: 1_000_000 };
    const removedPaths: string[] = [];
    const t = setup({ clock: () => clock.t, helperWorkspace: { ...slowMake(clock, HELPER_START_LIMIT_MS + 1_000), remove: async (path) => void removedPaths.push(path) } });
    expect(await ask(t.coordinator)).toEqual({ ok: false, error: expect.stringContaining("too long") });
    expect(removedPaths).toEqual(["/cards/w.helper-2-1"]);
    expect(t.c.calls).toEqual([]);
    expect(t.coordinator.delegatedLocks()).toEqual([]);
    expect(t.coordinator.status()).toBeNull();
  });

  it("makes no workspace when the sync alone used the time", async () => {
    const clock = { t: 1_000_000 };
    const t = setup({ clock: () => clock.t, importer: { sync: async () => ((clock.t += HELPER_START_LIMIT_MS + 1_000), { ok: true as const, head: BASE, changed: false }) } });
    expect(await ask(t.coordinator)).toEqual({ ok: false, error: expect.stringContaining("too long") });
    expect(t.made).toEqual([]);
  });

  it("starts the helper when the clone took less than the limit", async () => {
    const clock = { t: 1_000_000 };
    const t = setup({ clock: () => clock.t, helperWorkspace: slowMake(clock, HELPER_START_LIMIT_MS - 1_000) });
    expect(await ask(t.coordinator)).toMatchObject({ ok: true });
    expect(t.c.calls).toHaveLength(1);
  });

  it("makes the limit 75 s, inside the factory's 90 s wait", () => {
    expect(HELPER_START_LIMIT_MS).toBe(75_000);
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
    expect(t.coordinator.delegatedLockSets()).toEqual([{ files: ["src/ui/Card.tsx", "src/ui/Card.test.tsx"], base: BASE }]);
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

describe("helperRuns: a request that is still starting when the run ends", () => {
  const slowMake = () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const make = async (...a: unknown[]) => (await gate, { path: `/cards/w.helper-${a[3]}-${a[4]}`, branch: `luna-helper-${a[3]}`, ref: `refs/luna/helper/task1/${a[3]}` });
    return { open, make };
  };
  const cases: Array<[string, (c: ReturnType<typeof helperRuns>) => Promise<unknown>]> = [
    ["afterRun(fail)", (c) => c.afterRun("fail")],
    ["afterRun(pass)", (c) => c.afterRun("pass")],
    ["cancel", (c) => c.cancel()],
  ];
  for (const [name, end] of cases) {
    it(`starts no helper when ${name} began before its workspace was made, and removes that workspace`, async () => {
      const slow = slowMake();
      const t = setup({ helperWorkspace: { make: slow.make as never, remove: async (path: string) => void t.removed.push(path) } });
      const asked = ask(t.coordinator);
      await tick();
      const ending = end(t.coordinator);
      await tick();
      slow.open();
      expect(await asked).toEqual({ ok: false, error: "the run has ended" });
      await ending;
      expect(t.c.calls).toEqual([]);
      expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
      expect(t.coordinator.status()).toBeNull();
      expect(t.coordinator.delegatedLocks()).toEqual([]);
    });
  }

  it("refuses a request that arrives after the run ended, without touching the importer", async () => {
    const t = setup();
    await t.coordinator.cancel();
    expect(await ask(t.coordinator)).toEqual({ ok: false, error: "the run has ended" });
    expect(t.log).toEqual([]);
    expect(t.made).toEqual([]);
  });

  it("stops waiting for a request that never finishes", async () => {
    const t = setup({ helperWorkspace: { make: () => new Promise(() => {}), remove: async () => {} } as never });
    void ask(t.coordinator);
    await tick();
    await expect(t.coordinator.cancel()).resolves.toBeUndefined();
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

  it("records the helper's end as cancelled, not failed, when its own signal was aborted", async () => {
    const t = setup();
    await ask(t.coordinator);
    const done = t.coordinator.cancel();
    t.c.settle({ outcome: "fail", detail: { error: "aborted" } });
    await done;
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_ended", payload: expect.objectContaining({ slice: 2, outcome: "cancelled" }) });
  });

  it("records the helper's end as cancelled when the implementer's abort stopped it", async () => {
    const t = setup();
    await ask(t.coordinator);
    t.abort.abort();
    t.c.settle({ outcome: "fail", detail: { error: "aborted" } });
    await tick();
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_ended", payload: expect.objectContaining({ outcome: "cancelled" }) });
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
  it("holds the shas picked on earlier runs of the card, readable while the run goes", () => {
    const t = setup({ priorPicked: ["d".repeat(40)] });
    expect([...t.coordinator.picked()]).toEqual(["d".repeat(40)]);
  });
});

/** A helper that ran, passed and was taken: `returned`, ready for the pick. */
async function returned(over: Partial<HelperRunsDeps> = {}) {
  const t = setup(over);
  await ask(t.coordinator);
  t.c.settle({ outcome: "pass" });
  await tick();
  expect(await stateOf(2)).toMatchObject({ state: "returned" });
  return t;
}
const pickReq = (t: { coordinator: ReturnType<typeof helperRuns> }, head = BASE, n = 5) => t.coordinator.onPickRequest({ nonce: "ab12cd34", n, slice: 2, head });
const ackReq = (t: { coordinator: ReturnType<typeof helperRuns> }, head = PICKED, n = 6) => t.coordinator.onPickAck({ nonce: "ab12cd34", n, slice: 2, head });
const named = (t: { calls: unknown[][] }, name: string) => t.calls.filter((c) => c[0] === name);

describe("helperRuns: the pick", () => {
  it("answers a helper that has not returned, a slice it does not hold and a head that is no commit id with a plain refusal", async () => {
    const t = setup();
    await ask(t.coordinator);
    expect(await pickReq(t)).toEqual({ ok: false, error: expect.stringContaining("not returned") });
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await t.coordinator.onPickRequest({ nonce: "ab12cd34", n: 5, slice: 3, head: BASE })).toEqual({ ok: false, error: expect.stringContaining("slice 3") });
    expect(await pickReq(t, "HEAD")).toMatchObject({ ok: false });
    expect(named(t, "pickOnto")).toEqual([]);
  });

  it("asks the factory to bundle again when the card's tip is not its head, and picks nothing", async () => {
    const t = await returned();
    t.setHead("f".repeat(40));
    expect(await pickReq(t)).toEqual({ ok: false, retry: true, error: "your commits are not all in yet" });
    expect(named(t, "pickOnto")).toEqual([]);
  });

  it("picks onto the head, writes pick-<nonce>-<n>.bundle in the mailbox and answers with the shas, the state picking", async () => {
    const t = await returned();
    const answer = await pickReq(t);
    expect(answer).toEqual({ ok: true, tip: PICKED, picked: [PICKED], bundle: "pick-ab12cd34-5.bundle" });
    expect(named(t, "pickOnto")).toEqual([["pickOnto", "/cards/w", BASE, [COMMIT], { name: "Luna Machine", email: "machine@luna.test" }, "Luna-Helper: ui-designer, slice 2", { task: "task1", slice: 2 }]]);
    expect(named(t, "pickBundle")[0]!.slice(0, 4)).toEqual(["pickBundle", "/cards/w", BASE, "refs/luna/helper/task1/2-picked"]);
    expect(await readFile(join(out, "checks", "pick-ab12cd34-5.bundle"), "utf8")).toBe("bundle bytes");
    expect(await stateOf(2)).toMatchObject({ state: "picking" });
    // Nothing moved yet.
    expect(named(t, "advanceBranch")).toEqual([]);
    expect(t.coordinator.picked().has(PICKED)).toBe(false);
  });

  it("moves the branch on the ack: advance P to the tip, a picked row, a publish, committed, the files freed and the workspace removed", async () => {
    const t = await returned();
    await pickReq(t);
    expect(await ackReq(t)).toEqual({ ok: true });
    expect(await stateOf(2)).toEqual({ state: "committed", attempt: 1, commit: PICKED });
    expect(named(t, "advanceBranch")).toEqual([["advanceBranch", "/cards/w", "luna/card", BASE, PICKED]]);
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_picked", payload: { slice: 2, base: BASE, helperTip: TIP, onto: BASE, picked: [PICKED], tip: PICKED } });
    expect(named(t, "publish")).toHaveLength(1);
    expect(await stateOf(2)).toMatchObject({ state: "committed" });
    // L7-4: a slice the helper built and the machine picked stays the helper's for the whole run.
    expect(t.coordinator.delegatedLocks()).toEqual(["src/ui/Card.tsx", "src/ui/Card.test.tsx"]);
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
    expect([...t.coordinator.picked()]).toEqual([PICKED]);
    // No folder update inside the run: the container did its own merge.
    expect(named(t, "landInWorktree")).toEqual([]);
  });

  it("makes a note, not a failure, when the publish is refused", async () => {
    const t = await returned({ publish: async () => ({ ok: false as const, note: "the branch was not updated" }) });
    await pickReq(t);
    expect(await ackReq(t)).toEqual({ ok: true });
    expect(named(t, "note")).toEqual([["note", expect.stringContaining("the branch was not updated")]]);
  });

  it("refuses an ack for another head or with no pick waiting, moves nothing, and drops the pending pick", async () => {
    const t = await returned();
    expect(await ackReq(t)).toEqual({ ok: false, reason: expect.stringContaining("no pick") });
    await pickReq(t);
    expect(await ackReq(t, "9".repeat(40))).toEqual({ ok: false, reason: expect.stringContaining("not the picked tip") });
    expect(named(t, "advanceBranch")).toEqual([]);
    expect(await stateOf(2)).toMatchObject({ state: "returned" });
    expect(await ackReq(t)).toEqual({ ok: false, reason: expect.stringContaining("no pick") });
  });

  it("answers the reason when the branch moved since the pick, drops the pending pick and lets the next request pick onto the new tip", async () => {
    const t = await returned();
    await pickReq(t);
    t.setAdvance({ ok: false, reason: "moved" });
    expect(await ackReq(t)).toEqual({ ok: false, reason: expect.stringContaining("moved") });
    expect(await stateOf(2)).toMatchObject({ state: "returned" });
    expect(named(t, "publish")).toEqual([]);
    expect(t.rows.map((r) => r.kind)).not.toContain("build.helper_picked");
    // The implementer committed P2 meanwhile; the importer has it; the factory asks again with that head.
    const P2 = "7".repeat(40);
    t.setHead(P2);
    t.setAdvance({ ok: true });
    expect(await pickReq(t, P2, 7)).toMatchObject({ ok: true, bundle: "pick-ab12cd34-7.bundle" });
    expect(named(t, "pickOnto").at(-1)![2]).toBe(P2);
    expect(await ackReq(t, PICKED, 8)).toEqual({ ok: true });
    expect(named(t, "advanceBranch").at(-1)).toEqual(["advanceBranch", "/cards/w", "luna/card", P2, PICKED]);
  });

  it("serializes: a pick request that arrives while an ack is moving the branch waits for it", async () => {
    const t = await returned();
    await pickReq(t);
    const release = t.holdAdvance();
    const ack = ackReq(t);
    await tick();
    let answered = false;
    const next = pickReq(t, BASE, 9).then((answer) => ((answered = true), answer));
    await tick();
    expect(answered).toBe(false);
    release();
    expect(await ack).toEqual({ ok: true });
    // It runs after the ack: the slice is committed by then, so there is nothing left to pick.
    expect(await next).toEqual({ ok: false, error: expect.stringContaining("no ui-designer commits") });
  });

  it("goes to failed, freeing everything, when the pick fails for a reason other than a conflict", async () => {
    const t = await returned();
    t.setPick({ ok: false, conflict: false, reason: "merge-tree failed" });
    expect(await pickReq(t)).toEqual({ ok: false, error: expect.stringContaining("merge-tree failed") });
    expect(await stateOf(2)).toMatchObject({ state: "failed" });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
    expect(t.coordinator.delegatedLocks()).toEqual([]);
  });

  it("goes to failed when a pass returned no commits (nothing to pick)", async () => {
    const t = setup();
    t.setTake({ ok: true, tip: BASE, commits: [] });
    await ask(t.coordinator);
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await stateOf(2)).toMatchObject({ state: "failed", summary: expect.stringContaining("no commits") });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
  });
});

describe("helperRuns: a pick that landed", () => {
  it("is not picked again when an ack lands while the end of the run waits its turn (L7-2)", async () => {
    const t = await returned();
    await pickReq(t);
    const release = t.holdAdvance();
    const ack = ackReq(t);
    await tick();
    const end = t.coordinator.afterRun("pass");
    await tick();
    release();
    expect(await ack).toEqual({ ok: true });
    expect(await end).toBeNull();
    expect(named(t, "pickOnto")).toHaveLength(1);
    expect(named(t, "advanceBranch")).toHaveLength(1);
    expect(t.rows.filter((r) => r.kind === "build.helper_picked")).toHaveLength(1);
    expect(await stateOf(2)).toMatchObject({ state: "committed" });
  });

  it("is not picked again at the end of the run when the card's tip descends from the picked tip (L7-3)", async () => {
    const t = await returned();
    await pickReq(t);
    // The ack was lost; the factory merged the picked tip and the implementer committed on top of it.
    t.setHead("7".repeat(40));
    t.setDescends(true);
    expect(await t.coordinator.afterRun("pass")).toBeNull();
    expect(named(t, "pickOnto")).toHaveLength(1);
    expect(t.rows.filter((r) => r.kind === "build.helper_picked")).toEqual([{ kind: "build.helper_picked", payload: { slice: 2, base: BASE, helperTip: TIP, onto: BASE, picked: [PICKED], tip: PICKED } }]);
    expect(await stateOf(2)).toMatchObject({ state: "committed" });
  });

  it("counts an ack as landed when the branch moved on past the picked tip (L7-3)", async () => {
    const t = await returned();
    await pickReq(t);
    t.setAdvance({ ok: false, reason: "moved" });
    t.setHead("7".repeat(40));
    t.setDescends(true);
    expect(await ackReq(t)).toEqual({ ok: true });
    expect(await stateOf(2)).toMatchObject({ state: "committed" });
    expect(t.rows.filter((r) => r.kind === "build.helper_picked")).toHaveLength(1);
    expect(t.coordinator.picked().has(PICKED)).toBe(true);
  });
});

describe("helperRuns: the helper's refs (L7-7)", () => {
  const dropped = ["dropHelperRefs", "/cards/w", "task1", 2];

  it("deletes them once the pick has landed, by the ack and at the end of the run", async () => {
    const acked = await returned();
    await pickReq(acked);
    expect(named(acked, "dropHelperRefs")).toEqual([]);
    await ackReq(acked);
    expect(named(acked, "dropHelperRefs")).toEqual([dropped]);
    const ended = await returned();
    await ended.coordinator.afterRun("pass");
    expect(named(ended, "dropHelperRefs")).toEqual([dropped]);
  });

  it("keeps them for a helper that did not land (failed, cancelled, a re-run), so a person can read its commits", async () => {
    const failed = setup();
    await ask(failed.coordinator);
    failed.c.settle({ outcome: "fail", detail: { error: "boom" } });
    await tick();
    expect(named(failed, "dropHelperRefs")).toEqual([]);
    const cancelled = setup();
    await ask(cancelled.coordinator);
    await cancelled.coordinator.cancel();
    expect(named(cancelled, "dropHelperRefs")).toEqual([]);
    const conflict = await returned();
    conflict.setPick({ ok: false, conflict: true, files: ["src/ui/Card.tsx"] });
    await pickReq(conflict);
    expect(await stateOf(2)).toMatchObject({ state: "conflict_rerun" });
    expect(named(conflict, "dropHelperRefs")).toEqual([]);
  });
});

describe("helperRuns: a conflict", () => {
  const P = "8".repeat(40);

  it("re-runs the helper once on a new workspace at the card's tip, with the conflicting files, and picks the second run clean", async () => {
    const t = await returned();
    t.setHead(P);
    t.setPick({ ok: false, conflict: true, files: ["src/ui/Card.tsx"] });
    expect(await pickReq(t, P)).toEqual({ ok: false, conflict: true, error: expect.stringContaining("conflict") });
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_conflict", payload: { slice: 2, attempt: 1, files: ["src/ui/Card.tsx"] } });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
    expect(t.made.at(-1)).toEqual(["/cards/w", P, "task1", 2, 2]);
    expect(await stateOf(2)).toMatchObject({ state: "conflict_rerun", attempt: 2 });
    expect(t.c.calls).toHaveLength(2);
    expect(t.c.calls[1]!.context).toMatchObject({ runId: "run-9-helper-2-2" });
    expect(t.c.calls[1]!.extra.helper).toMatchObject({ attempt: 2, base: P, conflict: { files: ["src/ui/Card.tsx"] } });
    expect(t.c.calls[1]!.extra.workspace).toEqual({ path: "/cards/w.helper-2-2", branch: "luna-helper-2" });
    expect(t.coordinator.delegatedLocks()).toEqual(["src/ui/Card.tsx", "src/ui/Card.test.tsx"]);
    // The lock still begins where the helper first started: the implementer's commit that conflicted (between BASE and P) stays judged.
    expect(t.coordinator.delegatedLockSets()).toEqual([{ files: ["src/ui/Card.tsx", "src/ui/Card.test.tsx"], base: BASE }]);
    // The second run returns; this time it picks clean.
    t.setPick({ ok: true, picked: [PICKED], tip: PICKED });
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await stateOf(2)).toMatchObject({ state: "returned", attempt: 2 });
    expect(await pickReq(t, P, 6)).toMatchObject({ ok: true });
    expect(await ackReq(t, PICKED, 7)).toEqual({ ok: true });
    expect(t.rows.at(-1)!.payload).toMatchObject({ base: P, onto: P });
    expect(t.removed).toEqual(["/cards/w.helper-2-1", "/cards/w.helper-2-2"]);
  });

  it("goes to merge_conflict on a second conflict: a row, no third run, the end of the run escalates with the files", async () => {
    const t = await returned();
    t.setHead(P);
    t.setPick({ ok: false, conflict: true, files: ["src/ui/Card.tsx"] });
    await pickReq(t, P);
    t.c.settle({ outcome: "pass" });
    await tick();
    expect(await pickReq(t, P, 6)).toEqual({ ok: false, conflict: true, error: expect.stringContaining("conflict") });
    expect(await stateOf(2)).toMatchObject({ state: "merge_conflict" });
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_conflict", payload: { slice: 2, attempt: 2, files: ["src/ui/Card.tsx"] } });
    expect(t.c.calls).toHaveLength(2);
    expect(t.removed).toEqual(["/cards/w.helper-2-1", "/cards/w.helper-2-2"]);
    expect(t.coordinator.delegatedLocks()).toEqual([]);
    expect(await t.coordinator.afterRun("pass")).toEqual({ escalate: "merge_conflict", reason: expect.stringContaining("src/ui/Card.tsx") });
    expect(await t.coordinator.afterRun("fail")).toMatchObject({ escalate: "merge_conflict" });
  });

  it("goes to failed when the new workspace cannot be made, with no second run", async () => {
    const t = await returned({ helperWorkspace: { make: async (...a: unknown[]) => { if (a[4] === 2) throw new Error("disk full"); return { path: "/cards/w.helper-2-1", branch: "luna-helper-2", ref: "refs/luna/helper/task1/2" }; }, remove: async () => {} } as never });
    t.setPick({ ok: false, conflict: true, files: ["src/ui/Card.tsx"] });
    expect(await pickReq(t)).toMatchObject({ ok: false });
    expect(await stateOf(2)).toMatchObject({ state: "failed", summary: expect.stringContaining("disk full") });
    expect(t.c.calls).toHaveLength(1);
  });
});

describe("helperRuns: a re-run that is still being made when the run ends", () => {
  it("starts no second helper and removes its workspace (L7-1)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const removedPaths: string[] = [];
    const t = await returned({
      helperWorkspace: {
        make: async (...a: unknown[]) => {
          if (a[4] === 2) await gate;
          return { path: `/cards/w.helper-2-${a[4]}`, branch: "luna-helper-2", ref: "refs/luna/helper/task1/2" };
        },
        remove: async (path: string) => void removedPaths.push(path),
      } as never,
    });
    t.setPick({ ok: false, conflict: true, files: ["src/ui/Card.tsx"] });
    const pick = pickReq(t);
    await tick();
    const ended = t.coordinator.cancel();
    await tick();
    release();
    await pick;
    await ended;
    expect(t.c.calls).toHaveLength(1);
    expect(removedPaths).toContain("/cards/w.helper-2-2");
    expect(await stateOf(2)).toMatchObject({ state: "cancelled" });
  });
});

describe("helperRuns: the end of the run, after a pass", () => {
  it("waits for a running helper, picks onto the card's tip, moves the branch and updates the folder; the helper is not cancelled", async () => {
    const t = setup();
    await ask(t.coordinator);
    const P = "8".repeat(40);
    t.setHead(P);
    const end = t.coordinator.afterRun("pass");
    await tick();
    expect(t.c.calls[0]!.context.signal.aborted).toBe(false);
    t.c.settle({ outcome: "pass" });
    expect(await end).toBeNull();
    expect(named(t, "pickOnto").at(-1)![2]).toBe(P);
    expect(named(t, "advanceBranch")).toEqual([["advanceBranch", "/cards/w", "luna/card", P, PICKED]]);
    expect(named(t, "landInWorktree")).toEqual([["landInWorktree", "/cards/w", P, PICKED]]);
    expect(named(t, "publish")).toHaveLength(1);
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_picked", payload: { slice: 2, base: BASE, helperTip: TIP, onto: P, picked: [PICKED], tip: PICKED } });
    expect(await stateOf(2)).toMatchObject({ state: "committed" });
    expect(t.removed).toEqual(["/cards/w.helper-2-1"]);
    expect([...t.coordinator.picked()]).toEqual([PICKED]);
  });

  it("lands a helper that already returned the same way", async () => {
    const t = await returned();
    expect(await t.coordinator.afterRun("pass")).toBeNull();
    expect(await stateOf(2)).toMatchObject({ state: "committed", commit: PICKED });
    // L7-4: the files stay locked once landed, for the scope checks that run after the end of the run.
    expect(t.coordinator.delegatedLocks()).toEqual(["src/ui/Card.tsx", "src/ui/Card.test.tsx"]);
    expect(named(t, "landInWorktree")).toHaveLength(1);
    expect(await stateOf(2)).toMatchObject({ state: "committed" });
  });

  it("cancels a helper that is still running when its limit has passed, and picks nothing", async () => {
    let clock = 0;
    const t = setup({ now: () => (clock += 60 * 60_000) });
    await ask(t.coordinator);
    expect(await t.coordinator.afterRun("pass")).toBeNull();
    expect(t.c.calls[0]!.context.signal.aborted).toBe(true);
    expect(await stateOf(2)).toMatchObject({ state: "cancelled" });
    expect(named(t, "pickOnto")).toEqual([]);
  });

  it("escalates merge_conflict with the files when the folder update is refused (the pick is on the branch already)", async () => {
    const t = await returned();
    t.setLand({ ok: false, files: ["src/ui/Card.tsx"] });
    expect(await t.coordinator.afterRun("pass")).toEqual({ escalate: "merge_conflict", reason: expect.stringContaining("src/ui/Card.tsx") });
    expect(named(t, "advanceBranch")).toHaveLength(1);
    expect(t.rows.map((r) => r.kind)).toContain("build.helper_picked");
    expect(await stateOf(2)).toMatchObject({ state: "merge_conflict" });
  });

  it("escalates merge_conflict when the pick itself conflicts, with no re-run (the run is over)", async () => {
    const t = await returned();
    t.setPick({ ok: false, conflict: true, files: ["src/ui/Card.tsx"] });
    expect(await t.coordinator.afterRun("pass")).toEqual({ escalate: "merge_conflict", reason: expect.stringContaining("src/ui/Card.tsx") });
    expect(t.c.calls).toHaveLength(1);
    expect(named(t, "advanceBranch")).toEqual([]);
    expect(t.rows.at(-1)).toEqual({ kind: "build.helper_conflict", payload: { slice: 2, attempt: 1, files: ["src/ui/Card.tsx"] } });
  });

  it("cancels, and picks nothing, after anything but a pass", async () => {
    const t = await returned();
    expect(await t.coordinator.afterRun("escalated")).toBeNull();
    expect(await stateOf(2)).toMatchObject({ state: "cancelled" });
    expect(named(t, "pickOnto")).toEqual([]);
  });
});
