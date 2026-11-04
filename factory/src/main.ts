// Runs one pipeline stage inside its container.
//   in:  /in/stage.json, a StageInput from the machine
//   out: /out/result.json (StageOutput), /out/events.jsonl, /out/ledger.json, /out/files/**
//   cwd: /work, the task's worktree
// Stdout is a readable transcript; the board's watch pane follows it with `docker logs -f`. The
// runtime reports the run as events (core/events.ts): core prints them (core/transcript.ts) and
// writes them to /out/events.jsonl.
// LUNA_STAGE_DRY_RUN=1 renders the prompt and the SDK options without a model call.
// LUNA_STAGE_DEBUG=1 also writes every SDK message to /out/raw.jsonl.
// A helper on another runtime runs as a child of the stage (core/delegate.ts), into /out/children/<n>/.
// This file reads the input, renders the prompt and writes the result; the run itself is the
// runtime's (src/runtimes/).
import { PACKS, type RunEvent, type RunInfo, resolveEngine } from "@hardness/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { delegationFor, withChildren, withDelegate } from "./core/delegate.ts";
import type { Emit } from "./core/events.ts";
import { runInfo } from "./core/fingerprint.ts";
import { lunaHandlers } from "./core/luna-tools.ts";
import { EMPTY_RUN, type RunOutcome, finish, settle } from "./core/output.ts";
import { renderPrompt } from "./core/render.ts";
import { factoryTelemetry } from "./core/telemetry.ts";
import { readJson, readStageInput } from "./core/stage-io.ts";
import { transcript } from "./core/transcript.ts";
import { RUNTIMES } from "./runtimes/index.ts";

const env = process.env;
const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IN = env.LUNA_STAGE_IN ?? "/in/stage.json";
const OUT = env.LUNA_STAGE_OUT ?? "/out";
const WORK = env.LUNA_STAGE_WORK ?? "/work";
const DRY = env.LUNA_STAGE_DRY_RUN === "1";

const out = (line: string) => process.stdout.write(`${line}\n`);

mkdirSync(OUT, { recursive: true });
const input = readStageInput(IN, OUT);
if (!input) process.exit(1);
const pack = PACKS[input.pack];

// Every event the run emits, in order: printed as it comes, written by finish().
const events: RunEvent[] = [];
const print = transcript(out);
const emit: Emit = (event) => {
  events.push(event);
  print(event);
};

// The luna tools' state lives here, whatever runtime serves them: the result reads it.
// The machine answers the build checks through files under /out/checks; a dry run never waits for one.
const checkWaitMs = DRY ? 0 : Number(env.LUNA_CHECK_WAIT_MS ?? 90_000);
const luna = lunaHandlers({ ledgerPath: join(OUT, "ledger.json"), ledger: input.context.ledger ?? null, decisions: input.decisions, emit, checksDir: join(OUT, "checks"), checkWaitMs: Number.isFinite(checkWaitMs) ? checkWaitMs : 90_000 });

// Laminar, when the machine's traces are on: this run's spans nest under the machine's span for it.
const telemetry = await factoryTelemetry(env);
if (telemetry.on) out("luna factory · traces on (Laminar)");

out(`luna factory · pack ${pack.id} as ${pack.kind === "decision" ? "a decision" : (pack.agent ?? "script")} (attempt ${input.attempt})`);

// Script-only pack (evidence): no model. The outcome comes from the QA manifest e2e left.
if (pack.kind === "script") {
  const manifest = readJson(join(OUT, "files", "qa", "qa-manifest.json")) as { verdict?: string } | null;
  const verdict = manifest?.verdict ?? null;
  const good = verdict === "pass" || verdict === "skipped";
  const note = good ? `qa ${verdict}` : manifest ? `qa verdict: ${verdict ?? "missing"}` : "qa-manifest.json missing or unreadable";
  finish(OUT, pack, { ...EMPTY_RUN, ok: good, text: note, error: good ? null : note }, { ledger: luna.state.ledger, events });
  process.exit(0);
}

// The model's scratch space: under /tmp, but neither /tmp itself (HOME) nor the Codex home in it.
const scratch = mkdtempSync(join(tmpdir(), "luna-scratch-"));
// What the run ran on and its fingerprint, once its runtime is known.
let info: RunInfo | null = null;
const startedAt = Date.now();
let run: RunOutcome;
try {
  run = await runStage();
} catch (e) {
  // Whatever failed, the machine still finds a result that says why.
  run = { ...EMPTY_RUN, error: `the stage failed before it finished: ${e instanceof Error ? e.message : String(e)}` };
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// The spans must leave before the process exits.
await telemetry.flush();
// A rate limit, however the runtime learned of it, is one event.
if (run.rateLimited) emit({ kind: "rate_limit", payload: { resetsAt: run.resetsAt } });
finish(OUT, pack, run, { ledger: luna.state.ledger, events, run: info });

async function runStage(): Promise<RunOutcome> {
  // A decision pack has no prompt template: its runtime renders the questions and the input itself
  // (core/decide.ts for Claude and eve, Jev's own wire for Jev).
  let prompt = "";
  let template = JSON.stringify(pack.kind === "decision" ? pack.questions : null);
  if (pack.kind !== "decision") {
    template = readFileSync(join(FACTORY_ROOT, "prompts", pack.template), "utf8");
    const contextFile = join(WORK, "docs", "agents", "project-context.md");
    const projectContext = existsSync(contextFile) ? readFileSync(contextFile, "utf8") : null;
    prompt = renderPrompt({ pack, input: input!, template, projectContext });
    writeFileSync(join(OUT, "prompt.md"), prompt);
  }
  // The engine the machine chose, else the pack's default; its runtime runs the stage. An engine
  // on a runtime this factory does not carry yet fails the stage with a reason, not a crash.
  const engine = resolveEngine(input!.engine ?? pack.engines.default);
  const runtime = RUNTIMES[engine.runtime];
  if (!runtime) return { ...EMPTY_RUN, error: `engine ${engine.id} runs on ${engine.runtime}, which is not available in this factory yet` };
  info = runInfo(runtime, engine, pack, template, FACTORY_ROOT);
  const paths = { factoryRoot: FACTORY_ROOT, work: WORK, out: OUT, input: dirname(IN), scratch };
  // A helper the runtime does not run itself is a child run through `delegate`; the parent's turns
  // so far are its calls so far, which is never fewer.
  const turnsUsed = () => events.filter((e) => e.kind === "tool_call").length;
  const delegating = delegationFor(runtime.id, { pack, input: input!, paths, runtimes: RUNTIMES, emit, print: out, startedAt, turnsUsed });
  const run = await runtime.run({ pack, engine, input: input!, prompt, paths, luna: withDelegate(luna, delegating), dry: DRY, emit, delegate: delegating?.tool ?? null, telemetry });
  // A dry run answers nothing unless the test seam gave it an answer; that one is settled.
  return withChildren(DRY && run.structured === null ? run : settle(run, pack), delegating);
}
