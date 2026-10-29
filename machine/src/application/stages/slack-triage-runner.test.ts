import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { MemorySlackStore } from "../../test/slack.ts";
import { type TriageContext, type TriageItem, TriageRunError } from "../slack-triage.ts";
import { createSlackTriager } from "./slack-triage-runner.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");

const item = (id: string, over: Partial<TriageItem> = {}): TriageItem => ({ id, channel: "#eng", author: "@marta", text: `msg ${id}?`, context: ["@lee: earlier"], matched: ["me"], isBot: false, threadReplies: 0, ...over });
const verdict = (id: string) => ({ id, priority: "P1", category: "question", expectsReply: true, summary: "s".repeat(120), why: "w", draft: "d", refs: [], deadline: null });
const watches = [
  { id: "w1", kind: "usergroup" as const, value: "S1", label: "@platform-team", channels: [], enabled: true, builtin: false, priority: "P1" as const, createdAt: "" },
  { id: "w2", kind: "keyword" as const, value: "luna", label: "luna", channels: [], enabled: false, builtin: false, priority: null, createdAt: "" },
];
const context: TriageContext = { me: { id: "U1", name: "higor" }, notes: "Short replies.", learned: ["- @bot: lowered (2)"], vips: ["@cto"], watches };

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
/** What /work looked like when the sandbox ran: the folder is gone once the run answered. */
let seenWork: { isDir: boolean; listing: string[] }[];

/** A sandbox that leaves what the pack would: result.json under the run dir's out/. */
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

const idsOf = (run: SandboxRun) => (run.input as unknown as StageInput).context.slack!.items.map((i) => i.id);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "slack-triage-"));
  seen = [];
  seenWork = [];
});

describe("createSlackTriager", () => {
  it("runs the slack_triage pack in the stage container over an empty /work: the batch, the watches and the rules in stage.json", async () => {
    const store = new MemorySlackStore();
    const sandbox = fakeSandbox((run) => output({ items: idsOf(run).map(verdict) }));
    const triager = createSlackTriager({ image: "hardness-runner:dev", credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "t" }, stateDir, store, sandbox, now: () => NOW, log: () => {} });
    await triager.triage([item("C1:1"), item("C1:2", { isBot: true, threadReplies: 3, matched: ["usergroup:S1"] })], context);

    expect(seen).toHaveLength(1);
    const run = seen[0]!;
    expect(run).toMatchObject({ name: "hardness-slack-triage-2026-10-28T12-00-00-000Z", image: "hardness-runner:dev", writable: false, gitDir: null, timeoutMs: 180_000, credential: { name: "CLAUDE_CODE_OAUTH_TOKEN" }, labels: { luna: "slack-triage" } });
    expect(run.runDir).toBe(join(stateDir, "slack-triage", "2026-10-28T12-00-00-000Z"));
    expect(run.worktree).toBe(join(run.runDir, "work"));
    expect(seenWork[0]).toEqual({ isDir: true, listing: [] });
    expect(existsSync(run.runDir)).toBe(false);
    expect(run.sessionMount).toBeUndefined();
    expect(run.services).toBeUndefined();

    const input = StageInput.parse(run.input);
    expect(input).toMatchObject({ pack: "slack_triage", stage: "slack_triage", task: { id: "slack-triage", branch: "" }, plan: null, limits: { maxTurns: 3, timeoutMs: 180_000 } });
    const slack = input.context.slack!;
    expect(slack.me).toEqual({ id: "U1", name: "higor" });
    expect(slack.watches).toEqual([{ label: "@platform-team", kind: "usergroup" }]);
    expect(slack.rules).toContain("## VIPs (at least P1)\n- @cto");
    expect(slack.rules).toContain("## Notes\nShort replies.");
    expect(slack.rules).toContain("- @bot: lowered (2)");
    expect(slack.items).toEqual([
      { id: "C1:1", channel: "#eng", author: "@marta", isBot: false, text: "msg C1:1?", context: [{ user: "@lee", text: "earlier" }], matched: ["me"], threadReplies: 0 },
      { id: "C1:2", channel: "#eng", author: "@marta", isBot: true, text: "msg C1:2?", context: [{ user: "@lee", text: "earlier" }], matched: ["usergroup:S1"], threadReplies: 3 },
    ]);
  });

  it("validates the answer, keeps only the ids it asked about, cuts summaries to 90, and runs 25 items per container", async () => {
    const store = new MemorySlackStore();
    // Each run skips its last item and adds one nobody asked for.
    const sandbox = fakeSandbox((run) => output({ items: [...idsOf(run).slice(0, -1).map(verdict), verdict("other")] }));
    const triager = createSlackTriager({ image: "img", credential: { name: "ANTHROPIC_API_KEY", value: "k" }, stateDir, store, sandbox, now: () => NOW, log: () => {} });
    const items = Array.from({ length: 30 }, (_, i) => item(`C1:${i}`));
    const answers = await triager.triage(items, context);
    expect(seen).toHaveLength(2);
    expect(idsOf(seen[0]!)).toHaveLength(25);
    expect(idsOf(seen[1]!)).toHaveLength(5);
    expect(seen[1]!.runDir).toBe(join(stateDir, "slack-triage", "2026-10-28T12-00-00-000Z-2"));
    expect(answers.size).toBe(28);
    expect(answers.has("C1:24")).toBe(false);
    expect(answers.has("C1:29")).toBe(false);
    expect(answers.has("other")).toBe(false);
    expect(answers.get("C1:0")).toEqual({ priority: "P1", category: "question", expectsReply: true, summary: "s".repeat(90), why: "w", draft: "d", refs: [], deadline: null });

    // An answer that is not the pack's shape is a failed run: it rejects, and its folder stays for the sweep.
    const broken = createSlackTriager({ image: "img", credential: { name: "ANTHROPIC_API_KEY", value: "k" }, stateDir, store: new MemorySlackStore(), sandbox: fakeSandbox(() => output({ items: [{ id: "C1:1", priority: "P9" }] })), log: () => {} });
    await expect(broken.triage([item("C1:1")], context)).rejects.toThrow(TriageRunError);
    expect(existsSync(seen.at(-1)!.runDir)).toBe(true);
    // A second batch failing after a first that answered: the error carries the first batch's verdicts.
    let batches = 0;
    const half = createSlackTriager({ image: "img", credential: { name: "ANTHROPIC_API_KEY", value: "k" }, stateDir, store: new MemorySlackStore(), sandbox: fakeSandbox((run) => (batches++ === 0 ? output({ items: idsOf(run).map(verdict) }) : null)), log: () => {} });
    const partial = await half.triage(items, context).catch((e: unknown) => e);
    expect(partial).toBeInstanceOf(TriageRunError);
    expect((partial as TriageRunError).answers.size).toBe(25);
  });

  it("records every run: items, model, turns and cost on success; the reason on a failure, a timeout or a missing result", async () => {
    const store = new MemorySlackStore();
    const lines: string[] = [];
    const log = (line: string) => void lines.push(line);
    const credential = { name: "ANTHROPIC_API_KEY" as const, value: "k" };
    await createSlackTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox((run) => output({ items: idsOf(run).map(verdict) })), now: () => NOW, log }).triage([item("C1:1"), item("C1:2")], context);
    expect(store.runs).toEqual([{ id: "run-1", startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), items: 2, model: "claude-haiku-5-5", turns: 1, costUsd: 0.0042, ok: true, error: null }]);
    expect(lines[0]).toBe("slack triage: 2 item(s), 2 verdict(s), 1 turn(s) · $0.0042");

    const stamps = [new Date("2026-10-28T12:01:00Z"), new Date("2026-10-28T12:02:00Z")];
    let n = 0;
    const later = () => stamps[Math.floor(n++ / 2)]!;
    const failing = createSlackTriager({ image: "img", credential, stateDir, store, sandbox: async () => { throw new Error("docker: not running"); }, now: later, log });
    await expect(failing.triage([item("C1:3")], context)).rejects.toThrow("docker: not running");
    const timedOut = createSlackTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox(() => null, { timedOut: true }), now: later, log });
    await expect(timedOut.triage([item("C1:4")], context)).rejects.toThrow(/timed out/);
    const silent = createSlackTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox(() => null, { exitCode: 2 }), log });
    await expect(silent.triage([item("C1:5")], context)).rejects.toThrow(/left no result/);
    const stageFailed = createSlackTriager({ image: "img", credential, stateDir, store, sandbox: fakeSandbox(() => output(null, { ok: false, outcome: "fail", error: "no structured output", usage: { turns: 3, costUsd: 0.001, durationMs: 1, model: "claude-haiku-5-5" } })), log });
    await expect(stageFailed.triage([item("C1:6")], context)).rejects.toThrow("no structured output");
    expect(store.runs.slice(1).map((r) => [r.ok, r.error, r.turns, r.costUsd])).toEqual([
      [false, "docker: not running", 0, null],
      [false, "timed out after 3 minutes", 0, null],
      [false, "the container left no result (exit code 2)", 0, null],
      [false, "no structured output", 3, 0.001],
    ]);
    expect(store.runs[1]).toMatchObject({ startedAt: "2026-10-28T12:01:00.000Z", endedAt: "2026-10-28T12:01:00.000Z", model: "haiku" });
    expect(lines[1]).toBe("slack triage: 1 item(s) failed: docker: not running");
    expect(existsSync(join(stateDir, "slack-triage"))).toBe(true);
  });
});
