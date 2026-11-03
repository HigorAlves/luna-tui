// The conformance table (RFC 0003 §2): one set of scenarios every runtime runs against a fake of
// its own transport (a scripted `query()` for Claude, eve's `mockModel` for eve). A scenario is a
// script for the model, one step per model turn, in no runtime's words; each runtime's fake plays
// it through its SDK's shapes. The run is settled the way main.ts settles it, and the same checks
// apply to every runtime. A new runtime, or a major SDK bump, is done when the table passes.
import { type EngineId, type LunaTool, PACKS, StageInput, resolveEngine } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type RunOutcome, settle } from "../../core/output.ts";
import type { Runtime } from "../../core/runtime.ts";
import { lunaTools } from "../index.ts";

/** One model turn. A call's result is what the model reads next; `echo` puts the last result
 *  into the answer's summary, so a check can see what the model was told. */
export type ScriptStep =
  | { call: "bash"; command: string }
  | { call: "luna"; tool: LunaTool; args: Record<string, unknown> }
  | { answer: Record<string, unknown>; as?: "structured" | "text"; echo?: boolean }
  | { rateLimit: { resetsAt?: number } };

export interface Scenario {
  name: string;
  script: ScriptStep[];
  check(result: ConformanceResult, can: RuntimeCapabilities): void;
}

export interface ConformanceResult {
  run: RunOutcome;
  out: string;
  transcript: string[];
}

/** What a runtime's SDK can report at all; a check skips what it cannot. */
export interface RuntimeCapabilities {
  /** The SDK says when a rate limit resets. */
  resetsAt: boolean;
}

/** The pack every scenario runs: it has shell commands, the ledger tools and an answer schema. */
export const PACK = PACKS.implementing;
export const RESETS_AT = 1_900_000_000;
const DONE = { kind: "done", summary: "did it" };

export const SCENARIOS: Scenario[] = [
  {
    name: "a structured answer is the result",
    script: [{ answer: DONE }],
    check: ({ run }) => expect(run).toMatchObject({ ok: true, structured: DONE, error: null }),
  },
  {
    name: "an answer as JSON text is accepted when it parses against the pack's schema",
    script: [{ answer: DONE, as: "text" }],
    check: ({ run }) => expect(run).toMatchObject({ ok: true, structured: DONE }),
  },
  {
    name: "an answer off the schema fails the run with the issue",
    script: [{ answer: { kind: "maybe", summary: "x" } }],
    check: ({ run }) => {
      expect(run).toMatchObject({ ok: false, structured: null });
      expect(run.error).toMatch(/kind/);
    },
  },
  {
    name: "a rate limit marks the run rate limited",
    script: [{ rateLimit: { resetsAt: RESETS_AT } }],
    check: ({ run }, can) => {
      expect(run).toMatchObject({ ok: false, rateLimited: true });
      if (can.resetsAt) expect(run.resetsAt).toBe(RESETS_AT);
    },
  },
  {
    name: "a guarded call is refused before it runs and the run continues",
    script: [{ call: "bash", command: "git push origin HEAD" }, { answer: DONE, echo: true }],
    check: ({ run, transcript }) => {
      expect(run.ok).toBe(true);
      expect(run.structured?.summary).toMatch(/git push is not allowed/);
      expect(transcript.join("\n")).toMatch(/git push origin HEAD/);
    },
  },
  {
    name: "a ledger tool call updates /out/ledger.json",
    script: [{ call: "luna", tool: "slice_init", args: { slices: [{ id: 1, title: "parse the input" }] } }, { answer: DONE }],
    check: ({ run, out }) => {
      expect(run.ok).toBe(true);
      const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8"));
      expect(ledger.slices).toEqual([expect.objectContaining({ id: 1, title: "parse the input", status: "pending" })]);
    },
  },
];

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const stageInput = (engine: EngineId): StageInput =>
  StageInput.parse({
    schema: 3,
    stage: PACK.id,
    pack: PACK.id,
    engine,
    attempt: 1,
    task: { id: "t1", title: "Fix the bug", description: "It breaks", criteria: ["no crash"], repoPath: "/r", branch: "task/t1-fix", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null, testCases: [] },
    limits: { maxTurns: 8, timeoutMs: 60_000 },
    env: { LUNA_FACTORY: "1" },
  });

/** Runs one scenario on a runtime the way main.ts runs a stage, in a fresh /work and /out. */
export async function runScenario(runtime: Runtime, engine: EngineId): Promise<ConformanceResult> {
  const root = mkdtempSync(join(tmpdir(), "conformance-"));
  const work = join(root, "work");
  const out = join(root, "out");
  mkdirSync(work);
  mkdirSync(out);
  const transcript: string[] = [];
  const luna = lunaTools({ ledgerPath: join(out, "ledger.json"), decisions: [], onStep: () => {} });
  const input = stageInput(engine);
  const run = await runtime.run({
    pack: PACK,
    engine: resolveEngine(engine),
    input,
    prompt: "Do the job.",
    paths: { factoryRoot: FACTORY_ROOT, work, out },
    luna,
    dry: false,
    out: (line) => transcript.push(line),
  });
  return { run: settle(run, PACK), out, transcript };
}

/** Registers the table for one runtime: `runtimeFor` gives the runtime wired to a fake that plays
 *  the script. */
export function conformance(
  name: string,
  engine: EngineId,
  runtimeFor: (script: ScriptStep[]) => Runtime | Promise<Runtime>,
  can: RuntimeCapabilities,
  timeoutMs = 5_000,
): void {
  describe(`${name} runtime conformance`, () => {
    it.each(SCENARIOS)("$name", async (scenario) => {
      scenario.check(await runScenario(await runtimeFor(scenario.script), engine), can);
    }, timeoutMs);
  });
}
