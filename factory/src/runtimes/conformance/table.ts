// The conformance table (RFC 0003 §2): one set of scenarios every runtime runs against a fake of
// its own transport (a scripted `query()` for Claude, eve's `mockModel` for eve, a scripted client
// for Jev). A scenario is a script for the model, one step per model turn, in no runtime's words;
// each runtime's fake plays it through its SDK's shapes. The run is settled the way main.ts
// settles it, and the same checks apply to every runtime. A new runtime, or a major SDK bump, is
// done when the table passes.
import { type AgentPack, type AgentRole, type EngineId, type LunaTool, type Pack, PACKS, type RunEvent, StageInput, helpersOn, resolveEngine } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { delegationFor, withChildren, withDelegate } from "../../core/delegate.ts";
import { lunaHandlers } from "../../core/luna-tools.ts";
import { EMPTY_RUN, type RunOutcome, settle } from "../../core/output.ts";
import type { RunContext, Runtime } from "../../core/runtime.ts";
import { transcript as printer } from "../../core/transcript.ts";

/** One model turn. A call's result is what the model reads next, and `say` is text the model
 *  writes before it; `echo` puts the last result into the answer's summary, so a check can see
 *  what the model was told; `hang` never answers. */
export type ScriptStep =
  | { call: "bash"; command: string; say?: string }
  | { call: "luna"; tool: LunaTool; args: Record<string, unknown>; say?: string }
  | { call: "delegate"; helper: AgentRole; message: string; say?: string }
  | { answer: Record<string, unknown>; as?: "structured" | "text"; echo?: boolean }
  | { rateLimit: { resetsAt?: number } }
  | { fail: string }
  | { hang: true };

/** The pack a runtime runs the table on, and its answers in the runtime's words. */
export interface TablePack {
  pack: Pack;
  /** An answer the pack's schema accepts, as the fake gives it. */
  valid: Record<string, unknown>;
  /** The structured answer `valid` settles into. */
  expected: Record<string, unknown>;
  /** An answer the pack's schema refuses, as the fake gives it. */
  off: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  /** What the runtime must be able to do for the row to apply. */
  needs?: "tools" | "text" | "delegate";
  /** How a helper the row delegates to ends; it answers when the row does not say. */
  child?: ChildPlay;
  /** The stage's time limit, when the row is about it. */
  timeoutMs?: number;
  script(t: TablePack): ScriptStep[];
  check(result: ConformanceResult, can: RuntimeCapabilities, t: TablePack): void;
}

export interface ConformanceResult {
  run: RunOutcome;
  out: string;
  /** What the run emitted, in order, and the transcript core printed from it. */
  events: RunEvent[];
  transcript: string[];
  /** How long the runtime took, start to finish. */
  elapsedMs: number;
  /** What each delegated helper's run was given. */
  given: RunContext[];
  /** The engine the helper runs on under this runtime. */
  helper: EngineId;
}

/** How the fake helper's run ends: an answer, a failure, or no run for want of its credential. */
export type ChildPlay = "answers" | "fails" | "no-credential";

/** The runtime a delegated helper runs on in the table: it answers or fails as the row says, and
 *  keeps what it was given. */
function fakeChild(play: ChildPlay, given: RunContext[]): Runtime {
  return {
    id: "eve",
    sdk: "eve",
    instructions: () => ({ role: "", rules: "", skills: [] }),
    run: async (ctx) => {
      given.push(ctx);
      ctx.emit({ kind: "usage", payload: { model: "fake", costUsd: CHILD_COST } });
      if (play === "fails") return { ...EMPTY_RUN, error: "the helper broke", costUsd: CHILD_COST, turns: 1 };
      return { ...EMPTY_RUN, ok: true, structured: SECOND_OPINION, costUsd: CHILD_COST, turns: 2 };
    },
  };
}

/** What a runtime's SDK can report at all; a check skips what it cannot, a row what does not apply. */
export interface RuntimeCapabilities {
  /** The SDK says when a rate limit resets. */
  resetsAt: boolean;
  /** An answer off the schema reaches the runtime, so core can name the issue (eve validates on
   *  its server and retries instead: the runtime only learns the schema was never met). */
  schemaIssue: boolean;
  /** The model calls tools (shell, luna) between turns; a decision runtime does not. */
  tools: boolean;
  /** The model can answer in plain text instead of a structured answer. */
  text: boolean;
  /** The runtime serves `delegate` when the pack has a helper it does not run itself. */
  delegate: boolean;
}

/** The helper the table's pack may delegate to: on a runtime that is neither of the agent
 *  runtimes' own subagents, so both reach it through `delegate`: Codex's under Claude, Claude's under eve. */
export const HELPER = { role: "security-reviewer", engine: "codex:sol", on: { eve: "claude:opus" } } as const;
/** The pack an agent runtime runs the table on: it has shell commands, the ledger tools, an answer
 *  schema and a helper it reaches through `delegate`. */
export const PACK: AgentPack = { ...PACKS.implementing, helpers: [HELPER] };
/** What the fake helper answers, and what it costs. */
const SECOND_OPINION = { answer: "one more thing to check", findings: [] };
const CHILD_COST = 0.25;
export const RESETS_AT = 1_900_000_000;
const DONE = { kind: "done", summary: "did it" };
export const AGENT_TABLE: TablePack = { pack: PACK, valid: DONE, expected: DONE, off: { kind: "maybe", summary: "x" } };
const TIMEOUT_MS = 2_000;

export const SCENARIOS: Scenario[] = [
  {
    name: "a structured answer is the result",
    script: (t) => [{ answer: t.valid }],
    check: ({ run }, _can, t) => expect(run).toMatchObject({ ok: true, structured: t.expected, error: null }),
  },
  {
    name: "an answer as JSON text is accepted when it parses against the pack's schema",
    needs: "text",
    script: (t) => [{ answer: t.valid, as: "text" }],
    check: ({ run }, _can, t) => expect(run).toMatchObject({ ok: true, structured: t.expected }),
  },
  {
    name: "an answer off the schema fails the run with the issue",
    script: (t) => [{ answer: t.off }],
    check: ({ run }, can) => {
      expect(run).toMatchObject({ ok: false, structured: null });
      expect(run.error).toMatch(can.schemaIssue ? /kind/ : /schema/);
    },
  },
  {
    name: "a rate limit marks the run rate limited",
    script: () => [{ rateLimit: { resetsAt: RESETS_AT } }],
    check: ({ run }, can) => {
      expect(run).toMatchObject({ ok: false, rateLimited: true });
      if (can.resetsAt) expect(run.resetsAt).toBe(RESETS_AT);
    },
  },
  {
    name: "a model error the provider will not retry fails the run with its message",
    script: () => [{ fail: "The 'x-model' model is not supported" }],
    check: ({ run }) => {
      expect(run).toMatchObject({ ok: false, structured: null, rateLimited: false });
      expect(run.error).toMatch(/The 'x-model' model is not supported/);
    },
  },
  {
    name: "a model that never answers ends the stage cleanly at its deadline",
    timeoutMs: TIMEOUT_MS,
    script: () => [{ hang: true }],
    check: ({ run, elapsedMs }) => {
      expect(run).toMatchObject({ ok: false, structured: null, rateLimited: false, error: expect.stringMatching(/time ran out/) });
      expect(elapsedMs).toBeLessThan(TIMEOUT_MS + 10_000);
    },
  },
  {
    name: "a guarded call is refused before it runs and the run continues",
    needs: "tools",
    script: (t) => [{ call: "bash", command: "git push origin HEAD" }, { answer: t.valid, echo: true }],
    check: ({ run, transcript, events }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(/git push is not allowed/);
      expect(transcript.join("\n")).toMatch(/git push origin HEAD/);
      // The refusal is in the audit trail, with its reason, once.
      const refused = events.filter((e) => e.kind === "tool_call" && !e.payload.allowed);
      expect(refused).toEqual([{ kind: "tool_call", payload: expect.objectContaining({ target: "git push origin HEAD", allowed: false, reason: expect.stringMatching(/git push is not allowed/) }) }]);
    },
  },
  {
    name: "a command a shell would expand is refused before it runs",
    needs: "tools",
    script: (t) => [{ call: "bash", command: "echo $(id)" }, { answer: t.valid, echo: true }],
    check: ({ run }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(/command substitution|not a shell/);
    },
  },
  {
    name: "a path outside the run's roots is refused before it runs",
    needs: "tools",
    script: (t) => [{ call: "bash", command: "cat /proc/1/environ" }, { answer: t.valid, echo: true }],
    check: ({ run }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(/outside this stage's roots/);
    },
  },
  {
    name: "a ledger tool call updates /out/ledger.json",
    needs: "tools",
    script: (t) => [{ call: "luna", tool: "slice_init", args: { slices: [{ id: 1, title: "parse the input" }] } }, { answer: t.valid }],
    check: ({ run, out, events }) => {
      expect(run.ok).toBe(true);
      expect(events).toContainEqual({ kind: "ledger.init", payload: { total: 1 } });
      const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8"));
      expect(ledger.slices).toEqual([expect.objectContaining({ id: 1, title: "parse the input", status: "pending" })]);
    },
  },
  {
    name: "a delegated helper's answer is the tool's result, its child events in order and its cost counted",
    needs: "delegate",
    script: (t) => [{ call: "delegate", helper: HELPER.role, message: "Review the diff" }, { answer: t.valid, echo: true }],
    check: ({ run, out, events, transcript, helper }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toContain(SECOND_OPINION.answer);
      const children = events.filter((e) => e.kind === "child");
      expect(children).toEqual([
        { kind: "child", payload: { phase: "start", runId: "child-1", pack: PACK.id, role: HELPER.role, engine: helper } },
        { kind: "child", payload: { phase: "end", runId: "child-1", pack: PACK.id, role: HELPER.role, engine: helper, ok: true, costUsd: CHILD_COST } },
      ]);
      // The child's start and end, then the call's result. The call itself is in the stream too,
      // but on eve it races the bridge that starts the child, so it is checked apart from the order.
      const start = events.indexOf(children[0]!);
      const end = events.indexOf(children[1]!);
      const result = events.findIndex((e, i) => i > end && e.kind === "tool_result" && /delegate$/.test(e.payload.tool));
      expect(events.some((e) => e.kind === "tool_call" && /delegate$/.test(e.payload.tool) && e.payload.target === HELPER.role)).toBe(true);
      expect([start < end, end < result]).toEqual([true, true]);
      // The parent's own fake costs nothing: what the run reports is the child's.
      expect(run.costUsd).toBeCloseTo(CHILD_COST);
      const child = JSON.parse(readFileSync(join(out, "children", "1", "result.json"), "utf8"));
      expect(child).toMatchObject({ ok: true, answer: SECOND_OPINION, usage: { costUsd: CHILD_COST } });
      expect(readFileSync(join(out, "children", "1", "events.jsonl"), "utf8")).toContain('"kind":"usage"');
      expect(readFileSync(join(out, "children", "1", "prompt.md"), "utf8")).toContain("Review the diff");
      expect(transcript).toContain(`↳ ${HELPER.role} on ${helper} answered · $0.2500`);
    },
  },
  {
    name: "a delegated helper runs at depth 1, read-only, within the parent's turns",
    needs: "delegate",
    script: (t) => [{ call: "delegate", helper: HELPER.role, message: "Review the diff" }, { answer: t.valid }],
    check: ({ run, given, helper }) => {
      expect(run.ok).toBe(true);
      expect(given).toHaveLength(1);
      const child = given[0]!;
      // No delegate tool and no helpers: a child cannot delegate again.
      expect(child.delegate ?? null).toBeNull();
      expect(child.pack).toMatchObject({ agent: HELPER.role, helpers: [], writable: false, access: { write: false } });
      expect(child.engine.id).toBe(helper);
      expect(child.input.limits.maxTurns).toBeLessThan(8);
    },
  },
  {
    name: "a helper that fails is the tool's error and the parent goes on",
    needs: "delegate",
    child: "fails",
    script: (t) => [{ call: "delegate", helper: HELPER.role, message: "Review the diff" }, { answer: t.valid, echo: true }],
    check: ({ run, events }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(/gave no answer: the helper broke/);
      expect(events.filter((e) => e.kind === "child").at(-1)?.payload).toMatchObject({ phase: "end", ok: false, error: "the helper broke" });
    },
  },
  {
    name: "a helper whose credential is missing is the tool's error and the parent goes on",
    needs: "delegate",
    child: "no-credential",
    script: (t) => [{ call: "delegate", helper: HELPER.role, message: "Review the diff" }, { answer: t.valid, echo: true }],
    check: ({ run, given, helper }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(helper.startsWith("codex") ? /no Codex login in this stage/ : /no Claude credential in this stage/);
      expect(given).toHaveLength(0);
    },
  },
];

/** The golden run: text, a progress step, a refused and an allowed command, a ledger call and an
 *  answer. Each runtime's transcript of it is pinned in its own test, so a change in how a run
 *  becomes transcript lines (the board's watch pane and the stuck detector read them) shows. */
export const GOLDEN: ScriptStep[] = [
  { call: "luna", tool: "step", args: { label: "reading the code", n: 1, of: 3 }, say: "Looking around first." },
  { call: "bash", command: "git push origin HEAD" },
  { call: "bash", command: "pwd" },
  { call: "luna", tool: "slice_init", args: { slices: [{ id: 1, title: "parse the input" }] } },
  { answer: DONE },
];

/** A transcript with what changes from run to run (a session id, a duration) masked. */
export const masked = (lines: string[]): string[] => lines.map((line) => line.replace(/^session \S+/, "session <id>").replace(/\b\d+ ms\b/, "<n> ms"));

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const stageInput = (pack: Pack, engine: EngineId, timeoutMs: number): StageInput =>
  StageInput.parse({
    schema: 3,
    stage: pack.id,
    pack: pack.id,
    engine,
    attempt: 1,
    task: { id: "t1", title: "Fix the bug", description: "It breaks", criteria: ["no crash"], repoPath: "/r", branch: "task/t1-fix", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null, testCases: [] },
    limits: { maxTurns: 8, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  });

/** Runs one scenario on a runtime the way main.ts runs a stage, in a fresh /work and /out under
 *  `root`; the caller removes `root`. */
export async function runScenario(runtime: Runtime, engine: EngineId, root: string, t: TablePack = AGENT_TABLE, timeoutMs = 60_000, child: ChildPlay = "answers"): Promise<ConformanceResult> {
  const work = join(root, "work");
  const out = join(root, "out");
  const scratch = join(root, "scratch");
  const codexHome = join(root, "codex");
  for (const dir of [work, out, scratch, codexHome]) mkdirSync(dir, { recursive: true });
  if (child !== "no-credential") writeFileSync(join(codexHome, "auth.json"), "{}");
  const transcript: string[] = [];
  const events: RunEvent[] = [];
  const print = printer((line) => transcript.push(line));
  const emit = (event: RunEvent) => {
    events.push(event);
    print(event);
  };
  const luna = lunaHandlers({ ledgerPath: join(out, "ledger.json"), decisions: [], emit });
  const input = stageInput(t.pack, engine, timeoutMs);
  const started = Date.now();
  // As main.ts wires it: a helper on a runtime this one does not run is a child through `delegate`.
  const given: RunContext[] = [];
  const paths = { factoryRoot: FACTORY_ROOT, work, out, input: root, scratch };
  const helperRuntime = fakeChild(child, given);
  const delegating = delegationFor(runtime.id, {
    pack: t.pack,
    input,
    paths,
    runtimes: { eve: helperRuntime, claude: helperRuntime },
    emit,
    print: (line) => transcript.push(line),
    env: { CODEX_HOME: codexHome, ...(child !== "no-credential" && { CLAUDE_CODE_OAUTH_TOKEN: "token" }) },
    startedAt: started,
    turnsUsed: () => events.filter((e) => e.kind === "tool_call").length,
  });
  const run = await runtime.run({ pack: t.pack, engine: resolveEngine(engine), input, prompt: "Do the job.", paths, luna: withDelegate(luna, delegating), dry: false, emit, delegate: delegating?.tool ?? null });
  return { run: withChildren(settle(run, t.pack), delegating), out, events, transcript, elapsedMs: Date.now() - started, given, helper: helpersOn(t.pack, runtime.id)[0]?.engine ?? engine };
}

/** Registers the table for one runtime: `runtimeFor` gives the runtime wired to a fake that plays
 *  the script. Rows the runtime cannot do are skipped; every row's folders are removed after it. */
export function conformance(
  name: string,
  engine: EngineId,
  runtimeFor: (script: ScriptStep[]) => Runtime | Promise<Runtime>,
  can: RuntimeCapabilities,
  { timeoutMs = 5_000, table = AGENT_TABLE }: { timeoutMs?: number; table?: TablePack } = {},
): void {
  describe(`${name} runtime conformance`, () => {
    const rows = SCENARIOS.filter((s) => (s.needs === undefined ? true : can[s.needs]));
    it.each(rows)("$name", async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), "conformance-"));
      try {
        const result = await runScenario(await runtimeFor(scenario.script(table)), engine, root, table, scenario.timeoutMs, scenario.child);
        scenario.check(result, can, table);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, timeoutMs + 15_000);
  });
}
