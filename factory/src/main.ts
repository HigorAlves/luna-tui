// Runs one pipeline stage inside its container.
//   in:  /in/stage.json, a StageInput from the machine
//   out: /out/result.json (StageOutput), /out/events.jsonl, /out/ledger.json, /out/files/**
//   cwd: /work, the task's worktree
// Stdout is a readable transcript; the board's watch pane follows it with `docker logs -f`.
// LUNA_STAGE_DRY_RUN=1 renders the prompt and the SDK options without a model call.
// LUNA_STAGE_DEBUG=1 also writes every SDK message to /out/raw.jsonl.
// This file reads the input, renders the prompt and writes the result; the run itself is the
// runtime's (src/runtimes/).
import { PACKS, resolveEngine } from "@hardness/contracts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EMPTY_RUN, finish, settle } from "./core/output.ts";
import { renderPrompt } from "./core/render.ts";
import { readJson, readStageInput } from "./core/stage-io.ts";
import { RUNTIMES, lunaTools } from "./runtimes/index.ts";

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
// A decision pack has no prompt: its runtime sends the pack's questions and the input as data.
let prompt = "";
if (pack.kind !== "decision") {
  const template = readFileSync(join(FACTORY_ROOT, "prompts", pack.template), "utf8");
  const contextFile = join(WORK, "docs", "agents", "project-context.md");
  const projectContext = existsSync(contextFile) ? readFileSync(contextFile, "utf8") : null;
  prompt = renderPrompt({ pack, input, template, projectContext });
  writeFileSync(join(OUT, "prompt.md"), prompt);
}

const luna = lunaTools({
  ledgerPath: join(OUT, "ledger.json"),
  ledger: input.context.ledger ?? null,
  decisions: input.decisions,
  onStep: (label, n, of) => out(`· ${label}${of ? ` (${n}/${of})` : ""}`),
});

out(`luna factory · pack ${pack.id} as ${pack.kind === "decision" ? "a decision" : (pack.agent ?? "script")} (attempt ${input.attempt})`);

// Script-only pack (evidence): no model. The outcome comes from the QA manifest e2e left.
if (pack.kind === "script") {
  const manifest = readJson(join(OUT, "files", "qa", "qa-manifest.json")) as { verdict?: string } | null;
  const verdict = manifest?.verdict ?? null;
  const good = verdict === "pass" || verdict === "skipped";
  const note = good ? `qa ${verdict}` : manifest ? `qa verdict: ${verdict ?? "missing"}` : "qa-manifest.json missing or unreadable";
  finish(OUT, pack, { ...EMPTY_RUN, ok: good, text: note, error: good ? null : note }, luna.state);
  process.exit(0);
}

// The engine the machine chose, else the pack's default; its runtime runs the stage. An engine
// on a runtime this factory does not carry yet fails the stage with a reason, not a crash.
const engine = resolveEngine(input.engine ?? pack.engines.default);
const runtime = RUNTIMES[engine.runtime];
if (!runtime) {
  finish(OUT, pack, { ...EMPTY_RUN, error: `engine ${engine.id} runs on ${engine.runtime}, which is not available in this factory yet` }, luna.state);
  process.exit(0);
}

const run = await runtime.run({ pack, engine, input, prompt, paths: { factoryRoot: FACTORY_ROOT, work: WORK, out: OUT }, luna, dry: DRY, out });
finish(OUT, pack, settle(run, pack), luna.state);
