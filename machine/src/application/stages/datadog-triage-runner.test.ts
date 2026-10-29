import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatadogItem, StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { InMemoryDatadogStore } from "../datadog-store.ts";
import { DATADOG_TRIAGE_BATCH } from "../datadog-triage.ts";
import { TriageRunError } from "../slack-triage.ts";
import { createDatadogTriager } from "./datadog-triage-runner.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");

const item = (id: string, over: Partial<DatadogItem> = {}): DatadogItem => ({
  id,
  source: "error_tracking",
  title: `Error ${id}`,
  service: "web",
  env: "prod",
  status: "OPEN",
  severity: null,
  count: 42,
  firstSeen: "2026-10-28T10:00:00.000Z",
  lastSeen: "2026-10-28T11:55:00.000Z",
  url: `https://app.datadoghq.com/${id}`,
  samples: ["boom"],
  repository: "acme/web",
  floor: "P2",
  triage: null,
  split: "investigate",
  snoozedUntil: null,
  doneAt: null,
  reopenedAt: null,
  resolvedAt: null,
  taskId: null,
  ...over,
});
const verdict = (id: string) => ({ id, priority: "P1", category: "new_error", summary: "s".repeat(90), why: "w", suspectedCause: null, nextStep: "look", refs: [] });

const output = (answer: unknown, over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 3,
  ok: true,
  outcome: "pass",
  summary: "",
  answer: answer as Record<string, unknown>,
  needsInput: null,
  requested: [],
  findings: [],
  artifacts: [],
  slices: { done: 0, total: 0 },
  commit: null,
  usage: { turns: 1, costUsd: 0.0042, durationMs: 900, model: "claude-haiku-5-5" },
  error: null,
  rateLimited: false,
  resetsAt: null,
  ...over,
});

let stateDir: string;
let seen: SandboxRun[];
let seenWork: { isDir: boolean; listing: string[] }[];

function fakeSandbox(answer: (run: SandboxRun) => StageOutput | null, result: Partial<SandboxResult> = {}): (run: SandboxRun) => Promise<SandboxResult> {
  return async (run) => {
    seen.push(run);
    seenWork.push({ isDir: statSync(run.worktree).isDirectory(), listing: readdirSync(run.worktree) });
    const out = join(run.runDir, "out");
    mkdirSync(out, { recursive: true });
    const body = answer(run);
    if (body) writeFileSync(join(out, "result.json"), JSON.stringify(body));
    return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log"), ...result };
  };
}

const idsOf = (run: SandboxRun) => (run.input as unknown as StageInput).context.datadog!.items.map((i) => i.id);
const credential = { name: "CLAUDE_CODE_OAUTH_TOKEN" as const, value: "t" };

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "datadog-triage-"));
  seen = [];
  seenWork = [];
});

describe("createDatadogTriager", () => {
  it("runs the datadog_triage pack in the stage container over an empty /work, the batch in stage.json", async () => {
    const store = new InMemoryDatadogStore();
    const sandbox = fakeSandbox((run) => output({ items: idsOf(run).map(verdict) }));
    const triager = createDatadogTriager({ image: "hardness-runner:dev", credential, stateDir, store, sandbox, now: () => NOW, log: () => {} });
    await triager.triage([item("et:1"), item("inc:2", { source: "incident", count: null, reopenedAt: "2026-10-28T11:00:00.000Z", floor: null })], "env:prod");

    expect(seen).toHaveLength(1);
    const run = seen[0]!;
    expect(run).toMatchObject({ name: "hardness-datadog-triage-2026-10-28T12-00-00-000Z", image: "hardness-runner:dev", writable: false, gitDir: null, credential: { name: "CLAUDE_CODE_OAUTH_TOKEN" }, labels: { luna: "datadog-triage" } });
    expect(run.runDir).toBe(join(stateDir, "datadog-triage", "2026-10-28T12-00-00-000Z"));
    expect(run.worktree).toBe(join(run.runDir, "work"));
    expect(seenWork[0]).toEqual({ isDir: true, listing: [] });
    expect(existsSync(run.runDir)).toBe(false);

    const input = StageInput.parse(run.input);
    expect(input).toMatchObject({ pack: "datadog_triage", stage: "datadog_triage", task: { id: "datadog-triage", branch: "" }, plan: null, limits: { maxTurns: 3 } });
    expect(run.timeoutMs).toBe(input.limits.timeoutMs);
    const datadog = input.context.datadog!;
    expect(datadog.scope).toBe("env:prod");
    expect(datadog.items).toEqual([
      { id: "et:1", source: "error_tracking", title: "Error et:1", service: "web", env: "prod", status: "OPEN", severity: null, count: 42, firstSeen: "2026-10-28T10:00:00.000Z", lastSeen: "2026-10-28T11:55:00.000Z", samples: ["boom"], floor: "P2", reopened: false },
      { id: "inc:2", source: "incident", title: "Error inc:2", service: "web", env: "prod", status: "OPEN", severity: null, count: null, firstSeen: "2026-10-28T10:00:00.000Z", lastSeen: "2026-10-28T11:55:00.000Z", samples: ["boom"], floor: null, reopened: true },
    ]);
  });

  it("drops verdicts for unknown ids, batches by 20, and a failed batch throws with the earlier answers", async () => {
    const store = new InMemoryDatadogStore();
    const sandbox = fakeSandbox((run) => output({ items: [...idsOf(run).slice(0, -1).map(verdict), verdict("other")] }));
    const triager = createDatadogTriager({ image: "img", credential, stateDir, store, sandbox, now: () => NOW, log: () => {} });
    const items = Array.from({ length: 25 }, (_, i) => item(`et:${i}`));
    const answers = await triager.triage(items, "");
    expect(DATADOG_TRIAGE_BATCH).toBe(20);
    expect(seen.map((r) => idsOf(r).length)).toEqual([20, 5]);
    expect(seen[1]!.runDir).toBe(join(stateDir, "datadog-triage", "2026-10-28T12-00-00-000Z-2"));
    expect(answers.size).toBe(23);
    expect(answers.has("other")).toBe(false);
    expect(answers.has("et:19")).toBe(false);
    expect(answers.get("et:0")).toEqual({ priority: "P1", category: "new_error", summary: "s".repeat(90), why: "w", suspectedCause: null, nextStep: "look", refs: [] });

    // An answer off the pack's schema fails the run and its folder stays for the sweep.
    const broken = createDatadogTriager({ image: "img", credential, stateDir, store: new InMemoryDatadogStore(), sandbox: fakeSandbox(() => output({ items: [{ id: "et:1", priority: "P9" }] })), log: () => {} });
    await expect(broken.triage([item("et:1")], "")).rejects.toThrow(TriageRunError);
    expect(existsSync(seen.at(-1)!.runDir)).toBe(true);

    let batches = 0;
    const half = createDatadogTriager({ image: "img", credential, stateDir, store: new InMemoryDatadogStore(), sandbox: fakeSandbox((run) => (batches++ === 0 ? output({ items: idsOf(run).map(verdict) }) : null)), log: () => {} });
    const partial = await half.triage(items, "").catch((e: unknown) => e);
    expect(partial).toBeInstanceOf(TriageRunError);
    expect((partial as TriageRunError<unknown>).answers.size).toBe(20);
  });

  it("runs the later batches after a failed one and throws at the end with every answer", async () => {
    let batches = 0;
    const triager = createDatadogTriager({ image: "img", credential, stateDir, store: new InMemoryDatadogStore(), sandbox: fakeSandbox((run) => (batches++ === 0 ? null : output({ items: idsOf(run).map(verdict) }))), log: () => {} });
    const failed = await triager.triage(Array.from({ length: 25 }, (_, i) => item(`et:${i}`)), "").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TriageRunError);
    expect(seen).toHaveLength(2);
    expect([...(failed as TriageRunError<unknown>).answers.keys()]).toEqual(["et:20", "et:21", "et:22", "et:23", "et:24"]);
  });

  it("records every run: cost on success, the reason on a failure, a timeout or a missing result", async () => {
    const store = new InMemoryDatadogStore();
    const lines: string[] = [];
    const log = (line: string) => void lines.push(line);
    await createDatadogTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox((run) => output({ items: idsOf(run).map(verdict) })), now: () => NOW, log }).triage([item("et:1"), item("et:2")], "");
    expect(store.runs).toEqual([{ id: "1", startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), items: 2, model: "claude-haiku-5-5", turns: 1, costUsd: 0.0042, ok: true, error: null }]);
    expect(lines[0]).toBe("datadog triage: 2 item(s), 2 verdict(s), 1 turn(s) · $0.0042");

    const failing = createDatadogTriager({ image: "img", credential, stateDir, store, sandbox: async () => { throw new Error("docker: not running"); }, now: () => NOW, log });
    await expect(failing.triage([item("et:3")], "")).rejects.toThrow("docker: not running");
    const timedOut = createDatadogTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox(() => null, { timedOut: true }), now: () => NOW, log });
    await expect(timedOut.triage([item("et:4")], "")).rejects.toThrow(/timed out/);
    const silent = createDatadogTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox(() => null, { exitCode: 2 }), log });
    await expect(silent.triage([item("et:5")], "")).rejects.toThrow(/left no result/);
    expect(store.runs.slice(1).map((r) => [r.ok, r.error, r.turns, r.costUsd])).toEqual([
      [false, "docker: not running", 0, null],
      [false, expect.stringMatching(/^timed out after /), 0, null],
      [false, "the container left no result (exit code 2)", 0, null],
    ]);
    expect(lines[1]).toBe("datadog triage: 1 item(s) failed: docker: not running");
  });
});
