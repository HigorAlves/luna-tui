import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewOn } from "../../test/policies.ts";

import type { DecisionRecord, EngineId, StageOutput } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type Credentials, fixedCredentials } from "../credentials/index.ts";
import { engineBudgetGate, gatedCredentials, runtimeKillSwitch } from "../../application/engine-gates.ts";
import type { SandboxResult, SandboxRun } from "../docker/docker.ts";
import { PackRuns, type PackRunsDeps } from "../../application/pack-runs.ts";
import { buildPackRuns } from "../../bootstrap/stages.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PgPackRunStore } from "../persistence/pack-run-store.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("delete from pack_runs");
});

const chat = { source: "teams", me: { id: "8f2c", name: "Higor" }, items: [{ id: "chat:19:a", place: "Rafa Souza", kind: "dm", author: "Rafa Souza", isBot: false, text: "approve the rollout today?" }] };
const verdict = { id: "chat:19:a", priority: "P0", category: "request", expectsReply: true, summary: "approve the rollout today", why: "Rafa waits on it", draft: "Approved.", refs: [], deadline: null };

const output = (over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 3, ok: true, outcome: "pass", summary: "", answer: { items: [verdict] }, needsInput: null, requested: [], findings: [], artifacts: [], slices: { done: 0, total: 0 }, commit: null,
  usage: { turns: 1, costUsd: 0.0031, durationMs: 4200, model: "gpt-6-luna" }, error: null, rateLimited: false, resetsAt: null, ...over,
});

const sandboxOf = (body: StageOutput) => async (run: SandboxRun): Promise<SandboxResult> => {
  mkdirSync(join(run.runDir, "out"), { recursive: true });
  writeFileSync(join(run.runDir, "out", "result.json"), JSON.stringify(body));
  return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
};

const credentials = (missing: EngineId[] = []): Credentials => ({
  check: async (engine) => (missing.includes(engine) ? { available: false, reason: "no Codex login" } : { available: true }),
  prepare: async () => ({ env: {}, mounts: [], release: async () => {} }),
});

function appWith(body: StageOutput, opts: { missing?: EngineId[]; runs?: boolean; deps?: Partial<PackRunsDeps>; dailyUsd?: number } = {}) {
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, budget: { dailyUsd: opts.dailyUsd ?? null } });
  const runs = new PackRuns({
    image: "img", credentials: credentials(opts.missing), stateDir: mkdtempSync(join(tmpdir(), "runs-http-")), store: new PgPackRunStore(db), sandbox: sandboxOf(body), log: () => {},
    budget: { dailyUsd: pipeline.budget.dailyUsd, spentTodayUsd: () => pipeline.spentTodayUsd() },
    ...opts.deps,
  });
  return createApp({ db, pipeline, bus: new Bus(), ...(opts.runs === false ? {} : { runs }) });
}

const post = (app: ReturnType<typeof createApp>, body: unknown, client?: string, signal?: AbortSignal) =>
  app.request("/runs", { method: "POST", headers: { "content-type": "application/json", ...(client ? { "x-luna-client": client } : {}) }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });

describe("POST /runs", () => {
  it("runs one context-only pack and answers its validated answer and usage; the record names the client and keeps no text", async () => {
    const response = await post(appWith(output()), { pack: "chat_triage", engine: "codex:luna", context: { chat } }, "notch");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: { items: [verdict] }, usage: { model: "gpt-6-luna", engine: "codex:luna", turns: 1, durationMs: 4200, costUsd: 0.0031 } });
    const rows = await db.query("select * from pack_runs");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pack: "chat_triage", engine: "codex:luna", model: "gpt-6-luna", client: "notch", ok: true, error: null, turns: 1, duration_ms: 4200, cost_usd: "0.00310000" });
    expect(JSON.stringify(rows)).not.toMatch(/rollout|Approved/);
  });

  it("keeps a decision record as a client's, whatever client name the request sends: the header never makes a call the machine's own", async () => {
    const appended: DecisionRecord[] = [];
    const retro = { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMin: 310 }, runs: 14 } };
    const app = appWith(output({ answer: { worth: { value: true, p: 0.93 } } }), { deps: { decisions: { append: async (record) => void appended.push(record) } } });
    for (const client of ["intake", "plan", "ship"]) expect((await post(app, { pack: "worth_learning", engine: "claude:haiku", context: { ship: retro } }, client)).status).toBe(200);
    expect(appended.map((r) => [r.client, r.origin])).toEqual([["intake", "client"], ["plan", "client"], ["ship", "client"]]);
  });

  it("is 400 for a pack that runs in a task, eval_judge, an engine the pack does not allow, a context that does not fit, or a bad client name", async () => {
    const app = appWith(output());
    const cases: Array<[unknown, string]> = [
      [{ pack: "implementing", context: {} }, "not_on_demand"],
      [{ pack: "eval_judge", context: {} }, "not_on_demand"],
      [{ pack: "chat_triage", engine: "claude:opus", context: { chat } }, "engine_not_allowed"],
      [{ pack: "chat_triage", context: { issue: { title: "t", description: "d" } } }, "invalid_request"],
      [{ pack: "triage_signals", context: { issue: { title: "t" } } }, "invalid_request"],
      [{ pack: "nope", context: {} }, "invalid_request"],
    ];
    for (const [body, error] of cases) {
      const response = await post(app, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    expect((await post(app, { pack: "chat_triage", context: { chat } }, "no spaces please")).status).toBe(400);
    expect(await db.query("select * from pack_runs")).toEqual([]);
  });

  it("is 409 runtime_disabled for an engine on a runtime MACHINE_DISABLE_RUNTIMES turned off, without running", async () => {
    const credentials = gatedCredentials(fixedCredentials({}), [runtimeKillSwitch(["jev"])]);
    const response = await post(appWith(output(), { deps: { credentials } }), { pack: "triage_signals", engine: "jev", context: { issue: { title: "t", description: "d" } } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "runtime_disabled", message: "jev: disabled by MACHINE_DISABLE_RUNTIMES" });
    expect(await db.query("select 1 from pack_runs")).toEqual([]);
  });

  it("runs a decision pack on claude:haiku when its default engine is off, and accepts the engine by name", async () => {
    const credentials = gatedCredentials(fixedCredentials({}), [runtimeKillSwitch(["jev"])]);
    const issue = { title: "t", description: "d" };
    const labels = { kind: { choice: "bug", confidence: 0.9 }, type_of_work: { choice: "frontend", confidence: 0.8 }, ready: { value: true, p: 0.9 }, size: { choice: "S", confidence: 0.7 }, who: { score: 1, confidence: 0.8 }, what: { score: 1, confidence: 0.8 }, impact: { score: 1, confidence: 0.8 }, time: { score: 1, confidence: 0.8 }, demand: { score: 0, confidence: 0.8 }, risk_prelim: { choice: "low", confidence: 0.8 }, archive: { value: false, p: 0.05 }, archive_reason: { choice: "none", confidence: 0.9 } };
    const fell = await post(appWith(output({ answer: labels }), { deps: { credentials } }), { pack: "triage_signals", context: { issue } });
    expect(fell.status).toBe(200);
    expect(((await fell.json()) as { usage: { engine: string } }).usage.engine).toBe("claude:haiku");
    const named = await post(appWith(output({ answer: labels })), { pack: "triage_signals", engine: "claude:haiku", context: { issue } });
    expect(named.status).toBe(200);
  });

  it("is 409 budget for an engine at its monthly cap, without running", async () => {
    const spend = { engineSpendSinceUsd: async () => new Map([["codex:luna", 0], ["openai:luna", 3]]) };
    const credentials = gatedCredentials(fixedCredentials({}), [engineBudgetGate({ budgets: { openai: 3 }, spend })]);
    const response = await post(appWith(output(), { deps: { credentials } }), { pack: "chat_triage", engine: "codex:luna", context: { chat } });
    expect(response.status).toBe(200);
    const over = gatedCredentials(fixedCredentials({}), [engineBudgetGate({ budgets: { "codex:luna": 0, jev: 2 }, spend: { engineSpendSinceUsd: async () => new Map([["jev", 2.5]]) } })]);
    const refused = await post(appWith(output(), { deps: { credentials: over } }), { pack: "triage_signals", engine: "jev", context: { issue: { title: "t", description: "d" } } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "budget", message: "jev: over its monthly budget ($2.50 of $2.00 on jev)" });
  });

  it("is 409 no_credential when this machine lacks the engine's credential", async () => {
    const response = await post(appWith(output(), { missing: ["codex:luna"] }), { pack: "chat_triage", engine: "codex:luna", context: { chat } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_credential", message: "codex:luna: no Codex login" });
  });

  it("is 422 with the run's error when the pack ran and failed, and 429 with resetsAt on a usage limit", async () => {
    const failed = await post(appWith(output({ ok: false, outcome: "fail", answer: null, error: "no structured output" })), { pack: "chat_triage", context: { chat } });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ error: "run_failed", message: "no structured output" });
    const limited = await post(appWith(output({ ok: false, outcome: "fail", answer: null, error: "usage limit", rateLimited: true, resetsAt: 1_793_620_800 })), { pack: "chat_triage", context: { chat } });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited", message: "usage limit", resetsAt: new Date(1_793_620_800_000).toISOString() });
    // The limit on claude:haiku moved the call to codex:luna, its fallback, which hit one too: both recorded.
    expect((await db.query("select ok, engine from pack_runs order by started_at, engine")).map((r: { ok: boolean; engine: string }) => [r.ok, r.engine])).toEqual([
      [false, "claude:haiku"],
      [false, "claude:haiku"],
      [false, "codex:luna"],
    ]);
  });

  it("is 503 agents_off on a machine that runs no packs", async () => {
    const response = await post(appWith(output(), { runs: false }), { pack: "chat_triage", context: { chat } });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("agents_off");
  });

  it("goes by the asked engine's own credential: with no Claude credential a codex:luna call runs and a claude one is 409; 503 only with MACHINE_AGENTS=off", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const config = { agents: true, runnerImage: "img", stateDir: mkdtempSync(join(tmpdir(), "runs-http-")) };
    const deps = { credentials: credentials(["claude:haiku", "claude:sonnet", "claude:opus"]), store: new PgPackRunStore(db), sandbox: sandboxOf(output()), log: () => {} };
    const app = createApp({ db, pipeline, bus: new Bus(), runs: buildPackRuns(config, deps) });
    expect((await post(app, { pack: "chat_triage", engine: "codex:luna", context: { chat } })).status).toBe(200);
    const claude = await post(app, { pack: "chat_triage", context: { chat } });
    expect(claude.status).toBe(409);
    expect(((await claude.json()) as { error: string }).error).toBe("no_credential");
    expect(buildPackRuns({ ...config, agents: false }, deps)).toBeUndefined();
  });

  it("is 429 budget while the day's spend, pack runs included, is at its ceiling, without running", async () => {
    await db.query("insert into pack_runs (pack, engine, model, ok, turns, duration_ms, cost_usd, started_at, ended_at) values ('chat_triage', 'claude:haiku', 'm', true, 1, 10, 1.0, now(), now())");
    let ran = 0;
    const sandbox = sandboxOf(output());
    const response = await post(appWith(output(), { dailyUsd: 1, deps: { sandbox: (run) => ((ran += 1), sandbox(run)) } }), { pack: "chat_triage", context: { chat } });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "budget", message: "budget: $1.00 spent today of $1.00" });
    expect(ran).toBe(0);
    expect(await db.query("select * from pack_runs")).toHaveLength(1);
  });

  it("is 429 queue_full when every place is taken and the waiting list is full", async () => {
    const gates: Array<() => void> = [];
    const sandbox = sandboxOf(output());
    const app = appWith(output(), { deps: { max: 1, queue: 0, sandbox: async (run) => (await new Promise<void>((resolve) => gates.push(resolve)), sandbox(run)) } });
    const first = post(app, { pack: "chat_triage", context: { chat } });
    await expect.poll(() => gates.length).toBe(1);
    const refused = await post(app, { pack: "chat_triage", context: { chat } });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe("queue_full");
    gates.shift()!();
    expect((await first).status).toBe(200);
  });

  it("passes the request's signal through: a client that disconnects stops its container", async () => {
    let started = false;
    let stopped = false;
    const app = appWith(output(), {
      deps: {
        sandbox: async (run) => {
          started = true;
          await new Promise<void>((resolve) => run.signal!.addEventListener("abort", () => resolve()));
          stopped = true;
          return { exitCode: 137, timedOut: false, aborted: true, transcriptPath: "" };
        },
      },
    });
    const left = new AbortController();
    const response = post(app, { pack: "chat_triage", context: { chat } }, "notch", left.signal);
    await expect.poll(() => started).toBe(true);
    left.abort();
    expect((await response).status).toBe(499);
    expect(stopped).toBe(true);
    expect(await db.query("select ok, client from pack_runs")).toEqual([{ ok: false, client: "notch" }]);
  });
});
