// The conformance table (RFC 0003 §2): one set of scenarios every runtime runs against a fake of
// its own transport (a scripted `query()` for Claude, eve's `mockModel` for eve, a scripted client
// for Jev). A scenario is a script for the model, one step per model turn, in no runtime's words;
// each runtime's fake plays it through its SDK's shapes. The run is settled the way main.ts
// settles it, and the same checks apply to every runtime. A new runtime, or a major SDK bump, is
// done when the table passes.
import { type EngineId, type LunaTool, type Pack, PACKS, StageInput, resolveEngine } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { lunaHandlers } from "../../core/luna-tools.ts";
import { type RunOutcome, settle } from "../../core/output.ts";
import type { Runtime } from "../../core/runtime.ts";

/** One model turn. A call's result is what the model reads next; `echo` puts the last result
 *  into the answer's summary, so a check can see what the model was told; `hang` never answers. */
export type ScriptStep =
  | { call: "bash"; command: string }
  | { call: "luna"; tool: LunaTool; args: Record<string, unknown> }
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
  needs?: "tools" | "text";
  /** The stage's time limit, when the row is about it. */
  timeoutMs?: number;
  script(t: TablePack): ScriptStep[];
  check(result: ConformanceResult, can: RuntimeCapabilities, t: TablePack): void;
}

export interface ConformanceResult {
  run: RunOutcome;
  out: string;
  transcript: string[];
  /** How long the runtime took, start to finish. */
  elapsedMs: number;
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
}

/** The pack an agent runtime runs the table on: it has shell commands, the ledger tools and an answer schema. */
export const PACK = PACKS.implementing;
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
    check: ({ run, transcript }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(/git push is not allowed/);
      expect(transcript.join("\n")).toMatch(/git push origin HEAD/);
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
    check: ({ run, out }) => {
      expect(run.ok).toBe(true);
      const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8"));
      expect(ledger.slices).toEqual([expect.objectContaining({ id: 1, title: "parse the input", status: "pending" })]);
    },
  },
];

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
export async function runScenario(runtime: Runtime, engine: EngineId, root: string, t: TablePack = AGENT_TABLE, timeoutMs = 60_000): Promise<ConformanceResult> {
  const work = join(root, "work");
  const out = join(root, "out");
  const scratch = join(root, "scratch");
  for (const dir of [work, out, scratch]) mkdirSync(dir, { recursive: true });
  const transcript: string[] = [];
  const luna = lunaHandlers({ ledgerPath: join(out, "ledger.json"), decisions: [], onStep: () => {} });
  const input = stageInput(t.pack, engine, timeoutMs);
  const started = Date.now();
  const run = await runtime.run({
    pack: t.pack,
    engine: resolveEngine(engine),
    input,
    prompt: "Do the job.",
    paths: { factoryRoot: FACTORY_ROOT, work, out, input: root, scratch },
    luna,
    dry: false,
    out: (line) => transcript.push(line),
  });
  return { run: settle(run, t.pack), out, transcript, elapsedMs: Date.now() - started };
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
    const rows = SCENARIOS.filter((s) => (s.needs === "tools" ? can.tools : s.needs === "text" ? can.text : true));
    it.each(rows)("$name", async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), "conformance-"));
      try {
        const result = await runScenario(await runtimeFor(scenario.script(table)), engine, root, table, scenario.timeoutMs);
        scenario.check(result, can, table);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, timeoutMs + 15_000);
  });
}
