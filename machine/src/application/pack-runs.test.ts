import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type EngineId, StageInput, type StageOutput, resolveEngine } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { type Credentials, NoCredentialError } from "../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";
import { EngineNotAllowedError, NotOnDemandError, PACK_RUNS_DIR, type PackRunRecord, PackRuns, QueueFullError, RunAbortedError, RunFailedError, RunNoCredentialError, RunOverBudgetError, RunRateLimitedError } from "./pack-runs.ts";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const chat = {
  source: "teams",
  me: { id: "8f2c", name: "Higor" },
  items: [
    { id: "chat:19:a", place: "Rafa Souza", kind: "dm", author: "Rafa Souza", isBot: false, text: "approve the rollout?", flag: "urgent" },
    { id: "post:t:c:m", place: "Platform › incidents", kind: "channel", author: "Azure DevOps", isBot: true, text: "build 4411 failed" },
  ],
};
const verdict = (id: string) => ({ id, priority: "P1", category: "request", expectsReply: false, summary: "s", why: "w", draft: null, refs: [], deadline: null });

const output = (over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 3, ok: true, outcome: "pass", summary: "", answer: { items: [verdict("chat:19:a"), verdict("post:t:c:m")] }, needsInput: null, requested: [], findings: [], artifacts: [], slices: { done: 0, total: 0 }, commit: null,
  usage: { turns: 1, costUsd: 0.0031, durationMs: 4200, model: "gpt-6-luna" }, error: null, rateLimited: false, resetsAt: null, ...over,
});

let stateDir: string;
let seen: SandboxRun[];
let records: PackRunRecord[];
/** What the run folder held while the container ran: it is gone once the call ends. */
let held: string[];

function fakeSandbox(body: StageOutput | null, result: Partial<SandboxResult> = {}): (run: SandboxRun) => Promise<SandboxResult> {
  return async (run) => {
    seen.push(run);
    const out = join(run.runDir, "out");
    mkdirSync(out, { recursive: true });
    if (body) writeFileSync(join(out, "result.json"), JSON.stringify(body));
    held = readdirSync(run.runDir);
    return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log"), ...result };
  };
}

const credentials = (missing: EngineId[] = []): Credentials => ({
  check: async (engine) => (missing.includes(engine) ? { available: false, reason: "no Codex login: run codex login" } : { available: true }),
  prepare: async () => ({ env: { TOKEN: "t" }, mounts: [], release: async () => {} }),
});

const runs = (sandbox: (run: SandboxRun) => Promise<SandboxResult>, over: Partial<ConstructorParameters<typeof PackRuns>[0]> = {}) =>
  new PackRuns({ image: "hardness-runner:dev", credentials: credentials(), stateDir, store: { record: async (r) => void records.push(r) }, sandbox, now: () => NOW, log: () => {}, ...over });

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pack-runs-"));
  seen = [];
  records = [];
  held = [];
});

describe("PackRuns", () => {
  it("runs chat_triage on the engine asked for over an empty /work, answers the validated answer and the usage, and keeps nothing on disk", async () => {
    const result = await runs(fakeSandbox(output())).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, "notch");
    expect(result).toEqual({ answer: { items: [verdict("chat:19:a"), verdict("post:t:c:m")] }, usage: { model: "gpt-6-luna", engine: "codex:luna", turns: 1, durationMs: 4200, costUsd: 0.0031 } });
    const run = seen[0]!;
    expect(run).toMatchObject({ image: "hardness-runner:dev", writable: false, gitDir: null, labels: { luna: "run" }, credential: { env: { TOKEN: "t" } } });
    expect(run.name).toMatch(/^hardness-run-chat-triage-[0-9a-f-]{12}$/);
    expect(run.worktree).toBe(join(run.runDir, "work"));
    const input = StageInput.parse(run.input);
    expect(input).toMatchObject({ pack: "chat_triage", engine: "codex:luna", task: { id: "chat-triage" }, context: { chat } });
    expect(held).toContain("work");
    expect(existsSync(run.runDir)).toBe(false);
    expect(run.runDir.startsWith(join(stateDir, "pack-runs") + "/")).toBe(true);
    expect(readdirSync(join(stateDir, PACK_RUNS_DIR))).toEqual([]);
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
  });

  it("records each run without its context or answer: pack, engine, model, client, outcome, turns, duration, cost and times", async () => {
    await runs(fakeSandbox(output())).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, "notch");
    expect(records).toEqual([{ pack: "chat_triage", engine: "codex:luna", model: "gpt-6-luna", client: "notch", ok: true, error: null, turns: 1, durationMs: 4200, costUsd: 0.0031, startedAt: NOW.toISOString(), endedAt: NOW.toISOString() }]);
    expect(JSON.stringify(records)).not.toContain("approve the rollout");
    // A runner that names its run record: the runtime, pinned model, SDK version and fingerprint ride along.
    const run = { runtime: "eve", engine: "codex:luna", modelId: "gpt-6-luna-fast", sdk: { name: "eve", version: "1.0.0-rc.1" }, fingerprint: "e".repeat(64) };
    await runs(fakeSandbox(output({ run }))).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, "notch");
    expect(records[1]).toMatchObject({ runtime: "eve", modelId: "gpt-6-luna-fast", sdkVersion: "1.0.0-rc.1", fingerprint: run.fingerprint });
  });

  it("runs the pack's default engine when none is asked for, and issue_classify and jira_intake with their own contexts", async () => {
    await runs(fakeSandbox(output())).run({ pack: "chat_triage", context: { chat } }, null);
    expect(StageInput.parse(seen[0]!.input).engine).toBe("claude:haiku");
    const labels = { kind: { choice: "bug", confidence: 0.9 }, area: { choice: "board", confidence: 0.8 }, ready: { value: true, p: 0.9 }, size: { score: 1, confidence: 0.7 } };
    const classified = await runs(fakeSandbox(output({ answer: labels }))).run({ pack: "issue_classify", context: { issue: { title: "Board crashes on resize", description: "It panics." } } }, "notch");
    expect(classified.answer).toEqual(labels);
    expect(StageInput.parse(seen[1]!.input)).toMatchObject({ pack: "issue_classify", engine: "jev", context: { issue: { title: "Board crashes on resize" } } });
    const jira = { key: "PLAT-1", url: "https://a.atlassian.net/browse/PLAT-1", summary: "Login", description: "Sign in.", issueType: "Story", priority: null, labels: [], dueAt: null, comments: [], repoPath: null };
    const verdictOf = { verdict: "ready", reason: "clear", title: "Login", description: "d", criteria: ["c"] };
    expect((await runs(fakeSandbox(output({ answer: verdictOf }))).run({ pack: "jira_intake", context: { jira } }, null)).answer).toEqual(verdictOf);
    expect(StageInput.parse(seen[2]!.input)).toMatchObject({ pack: "jira_intake", engine: "claude:sonnet", context: { jira } });
  });

  it("refuses a pack that runs in a task, eval_judge, an engine the pack does not allow and a context that does not fit, before running anything", async () => {
    const r = runs(fakeSandbox(output()));
    await expect(r.run({ pack: "triage", context: {} }, null)).rejects.toThrow(NotOnDemandError);
    await expect(r.run({ pack: "eval_judge", context: { eval: {} } }, null)).rejects.toThrow(NotOnDemandError);
    await expect(r.run({ pack: "chat_triage", engine: "claude:opus", context: { chat } }, null)).rejects.toThrow(EngineNotAllowedError);
    await expect(r.run({ pack: "chat_triage", context: { issue: { title: "t", description: "d" } } }, null)).rejects.toThrow(ZodError);
    await expect(r.run({ pack: "chat_triage", context: { chat: { ...chat, items: [] } } }, null)).rejects.toThrow(ZodError);
    expect(seen).toEqual([]);
    expect(records).toEqual([]);
  });

  it("says no_credential without running or recording when the engine's credential is missing", async () => {
    const r = runs(fakeSandbox(output()), { credentials: credentials(["codex:luna"]) });
    await expect(r.run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, null)).rejects.toThrow(new RunNoCredentialError("codex:luna: no Codex login: run codex login"));
    const gone = runs(fakeSandbox(output()), { credentials: { ...credentials(), prepare: () => Promise.reject(new NoCredentialError("gone")) } });
    await expect(gone.run({ pack: "chat_triage", context: { chat } }, null)).rejects.toThrow(RunNoCredentialError);
    expect(seen).toEqual([]);
    expect(records).toEqual([]);
  });

  it("fails with the run's error when it gave no valid answer, and with when it resets on a usage limit; both recorded, neither kept on disk", async () => {
    await expect(runs(fakeSandbox(output({ ok: false, outcome: "fail", answer: null, error: "no structured output" }))).run({ pack: "chat_triage", context: { chat } }, null)).rejects.toThrow(new RunFailedError("no structured output"));
    await expect(runs(fakeSandbox(output({ answer: { items: [{ ...verdict("x"), summary: "s".repeat(91) }] } }))).run({ pack: "chat_triage", context: { chat } }, null)).rejects.toThrow(/^the answer did not match the schema: items\.0\.summary/);
    await expect(runs(fakeSandbox(null, { exitCode: 1 })).run({ pack: "chat_triage", context: { chat } }, null)).rejects.toThrow("the container left no result (exit code 1)");
    const limited = await runs(fakeSandbox(output({ ok: false, outcome: "fail", answer: null, error: "usage limit", rateLimited: true, resetsAt: 1_793_620_800 }))).run({ pack: "chat_triage", context: { chat } }, null).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RunRateLimitedError);
    expect((limited as RunRateLimitedError).resetsAt).toBe(new Date(1_793_620_800_000).toISOString());
    // The limit on claude:haiku moved the call to codex:luna, its fallback, which hit one too.
    expect(records.map((r) => [r.ok, r.error, r.engine])).toEqual([
      [false, "no structured output", "claude:haiku"],
      [false, expect.stringContaining("the answer did not match the schema"), "claude:haiku"],
      [false, "the container left no result (exit code 1)", "claude:haiku"],
      [false, "usage limit", "claude:haiku"],
      [false, "usage limit", "codex:luna"],
    ]);
    expect(records[2]).toMatchObject({ model: resolveEngine("claude:haiku").modelId, turns: 0, costUsd: null });
    expect(readdirSync(join(stateDir, PACK_RUNS_DIR))).toEqual([]);
  });

  it("tells the engine caps about a call with a cost, with no task nor repo", async () => {
    const calls: unknown[] = [];
    await runs(fakeSandbox(output()), { engineBudgets: { afterRun: async (engine, run) => void calls.push([engine, run]) } }).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, null);
    await runs(fakeSandbox(output({ usage: { turns: 1, costUsd: null, durationMs: 1, model: "m" } })), { engineBudgets: { afterRun: async (engine, run) => void calls.push([engine, run]) } }).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, null);
    expect(calls).toEqual([["codex:luna", { taskId: null, repo: null }]]);
  });

  describe("on a usage limit", () => {
    /** A sandbox where the engines in `limited` hit their usage limit and any other answers. */
    const limitedOn = (limited: EngineId[]) => async (run: SandboxRun) => {
      const engine = StageInput.parse(run.input).engine!;
      return fakeSandbox(limited.includes(engine) ? output({ ok: false, outcome: "fail", answer: null, error: `${engine} usage limit`, rateLimited: true, resetsAt: 1_793_620_800 }) : output({ usage: { turns: 1, costUsd: null, durationMs: 900, model: resolveEngine(engine).modelId } }))(run);
    };

    it("runs the call again on the pack's next fallback engine, which answers, and records both runs", async () => {
      const result = await runs(limitedOn(["codex:luna"])).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, "notch");
      expect(result.usage).toMatchObject({ engine: "claude:haiku", model: resolveEngine("claude:haiku").modelId });
      expect(seen.map((run) => StageInput.parse(run.input).engine)).toEqual(["codex:luna", "claude:haiku"]);
      expect(records.map((r) => [r.engine, r.ok])).toEqual([["codex:luna", false], ["claude:haiku", true]]);
    });

    it("answers rate_limited once every fallback has hit its limit too", async () => {
      await expect(runs(limitedOn(["codex:luna", "claude:haiku"])).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, null)).rejects.toBeInstanceOf(RunRateLimitedError);
      expect(seen).toHaveLength(2);
    });

    it("skips a fallback whose credential is missing, or whose window the pipeline holds", async () => {
      await expect(runs(limitedOn(["codex:luna"]), { credentials: credentials(["claude:haiku"]) }).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, null)).rejects.toBeInstanceOf(RunRateLimitedError);
      expect(seen).toHaveLength(1);
      seen = [];
      await expect(runs(limitedOn(["codex:luna"]), { latched: () => ["claude"] }).run({ pack: "chat_triage", engine: "codex:luna", context: { chat } }, null)).rejects.toBeInstanceOf(RunRateLimitedError);
      expect(seen).toHaveLength(1);
    });

    it("never falls back on a pack with no fallback", async () => {
      await expect(runs(limitedOn(["claude:sonnet"])).run({ pack: "jira_intake", context: { jira: { key: "PLAT-1", url: "https://a.atlassian.net/browse/PLAT-1", summary: "Login", description: "Sign in.", issueType: "Story", priority: null, labels: [], dueAt: null, comments: [], repoPath: null } } }, null)).rejects.toBeInstanceOf(RunRateLimitedError);
      expect(seen).toHaveLength(1);
    });
  });

  it("runs at most `max` calls at once; the next waits for one to finish", async () => {
    const gates: Array<() => void> = [];
    let running = 0;
    let most = 0;
    const slow = async (run: SandboxRun): Promise<SandboxResult> => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return fakeSandbox(output())(run);
    };
    const r = runs(slow, { max: 2 });
    const calls = [1, 2, 3].map(() => r.run({ pack: "chat_triage", context: { chat } }, null));
    await expect.poll(() => gates.length).toBe(2);
    gates.shift()!();
    await expect.poll(() => gates.length).toBe(2);
    while (gates.length > 0) gates.shift()!();
    await expect.poll(() => gates.length).toBe(0);
    await Promise.all(calls);
    expect(most).toBe(2);
    expect(seen).toHaveLength(3);
  });

  it("clears the pack run folders a crash left behind, and never a stage run's folder nor its evidence", async () => {
    mkdirSync(join(stateDir, PACK_RUNS_DIR, "chat_triage-x", "in"), { recursive: true });
    const qa = join(stateDir, "runs", "42", "files", "qa");
    mkdirSync(qa, { recursive: true });
    writeFileSync(join(qa, "shot.png"), "png");
    writeFileSync(join(stateDir, "runs", "42", "transcript.jsonl"), "{}");
    await runs(fakeSandbox(output())).clearLeftovers();
    expect(existsSync(join(stateDir, PACK_RUNS_DIR))).toBe(false);
    expect(existsSync(join(qa, "shot.png"))).toBe(true);
    expect(existsSync(join(stateDir, "runs", "42", "transcript.jsonl"))).toBe(true);
  });

  /** A sandbox that holds each run until its gate opens. */
  function gated() {
    const gates: Array<() => void> = [];
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return fakeSandbox(output())(run);
    };
    return { gates, sandbox };
  }

  it("bounds the waiting list: past it a call is refused at once with queue_full, nothing run nor recorded", async () => {
    const { gates, sandbox } = gated();
    const r = runs(sandbox, { max: 1, queue: 1 });
    const first = r.run({ pack: "chat_triage", context: { chat } }, null);
    await expect.poll(() => gates.length).toBe(1);
    const second = r.run({ pack: "chat_triage", context: { chat } }, null);
    await expect(r.run({ pack: "chat_triage", context: { chat } }, null)).rejects.toThrow(QueueFullError);
    gates.shift()!();
    await expect.poll(() => gates.length).toBe(1);
    gates.shift()!();
    await Promise.all([first, second]);
    expect(seen).toHaveLength(2);
    expect(records).toHaveLength(2);
  });

  it("drops a waiting call whose client left before it ran, and the next one takes the place", async () => {
    const { gates, sandbox } = gated();
    const r = runs(sandbox, { max: 1 });
    const first = r.run({ pack: "chat_triage", context: { chat } }, null);
    await expect.poll(() => gates.length).toBe(1);
    const left = new AbortController();
    const dropped = r.run({ pack: "chat_triage", context: { chat } }, null, left.signal).catch((e: unknown) => e);
    const third = r.run({ pack: "chat_triage", context: { chat } }, null);
    left.abort();
    expect(await dropped).toBeInstanceOf(RunAbortedError);
    gates.shift()!();
    await expect.poll(() => gates.length).toBe(1);
    gates.shift()!();
    await Promise.all([first, third]);
    expect(seen).toHaveLength(2);
    expect(records).toHaveLength(2);
    // A signal already aborted never waits nor runs.
    const gone = new AbortController();
    gone.abort();
    await expect(r.run({ pack: "chat_triage", context: { chat } }, null, gone.signal)).rejects.toThrow(RunAbortedError);
    expect(seen).toHaveLength(2);
  });

  it("stops the container when the client leaves mid-run: the signal reaches the sandbox, the run is recorded as aborted", async () => {
    const left = new AbortController();
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
      seen.push(run);
      await new Promise<void>((resolve) => run.signal!.addEventListener("abort", () => resolve()));
      return { exitCode: 137, timedOut: false, aborted: true, transcriptPath: "" };
    };
    const call = runs(sandbox).run({ pack: "chat_triage", context: { chat } }, "notch", left.signal).catch((e: unknown) => e);
    await expect.poll(() => seen.length).toBe(1);
    left.abort();
    expect(await call).toBeInstanceOf(RunAbortedError);
    expect(records).toMatchObject([{ ok: false, error: expect.stringContaining("client"), client: "notch" }]);
    expect(readdirSync(join(stateDir, PACK_RUNS_DIR))).toEqual([]);
  });

  it("refuses a call while the day's spend is at its ceiling, before running anything; runs under it or with no ceiling", async () => {
    const over = runs(fakeSandbox(output()), { budget: { dailyUsd: 5, spentTodayUsd: async () => 5.01 } });
    await expect(over.run({ pack: "chat_triage", context: { chat } }, null)).rejects.toThrow(new RunOverBudgetError("budget: $5.01 spent today of $5.00"));
    expect(seen).toEqual([]);
    expect(records).toEqual([]);
    await runs(fakeSandbox(output()), { budget: { dailyUsd: 5, spentTodayUsd: async () => 4.99 } }).run({ pack: "chat_triage", context: { chat } }, null);
    await runs(fakeSandbox(output()), { budget: { dailyUsd: null, spentTodayUsd: async () => 999 } }).run({ pack: "chat_triage", context: { chat } }, null);
    expect(seen).toHaveLength(2);
  });
});
