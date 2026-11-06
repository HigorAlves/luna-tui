// Replay evals (RFC 0003 §3): runs a pack's cases on an engine in the stage image, exactly like
// the machine runs a pack (runPackOnce: the docker sandbox and only that engine's credential),
// then grades each answer: the pack's schema, the case's checks, then the eval_judge pack.
//
//   pnpm eval --pack slack_triage --engine codex:luna [--against claude:haiku] [--case <id>]...
//             [--no-judge | --judge] [--trials N] [--dataset <name>] [--save-baseline] [--image hardness-runner:dev]
//
// A decision pack runs without the judge (its grade is the label and the confidence); --judge adds it.
// --trials N runs each case N times, each in its own container; --dataset <name> takes the cases from
// that Laminar dataset (its labelled datapoints) instead of the folder.
//
// Set LMNR_PROJECT_API_KEY (or ~/.config/hardness/lmnr-project-api-key) and each case is a trace and each
// engine's run an evaluation in your local Laminar (compose profile observe); MACHINE_TRACES=full attaches transcripts.
//
// Needs a model credential, so it runs locally, never in CI. Run folders (input, output,
// transcript) stay under evals/.runs/ for reading; delete them whenever.
import { EngineId, PACKS, PackId } from "@hardness/contracts";
import { machineCredentials } from "@hardness/machine/credentials";
import { imageExists } from "@hardness/machine/docker";
import { loadConfig } from "@hardness/machine/config";
import { buildEgress } from "@hardness/machine/egress";
import { PolicyStore } from "@hardness/machine/policy";
import { outputError, runPackOnce } from "@hardness/machine/run-once";
import { type Evaluation, buildTelemetry, tracesFromEnv } from "@hardness/machine/telemetry";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type EvalCase, baselinePath, caseInput, datasetCases, judgeInput, loadCases, parseTrials, prepareWorktree, verdictOf } from "./src/cases.ts";
import { formatDiff, formatScorecard } from "./src/format.ts";
import { type CaseResult, type JudgeVerdict, type Scorecard, caseResult, diffScorecards, gradeAnswer, scorecard } from "./src/grade.ts";
import { evalDatapoint } from "./src/report.ts";

const EVALS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVALS, "..");

const { values } = parseArgs({
  options: {
    pack: { type: "string" },
    engine: { type: "string" },
    against: { type: "string" },
    case: { type: "string", multiple: true },
    "no-judge": { type: "boolean", default: false },
    judge: { type: "boolean", default: false },
    trials: { type: "string" },
    dataset: { type: "string" },
    "save-baseline": { type: "boolean", default: false },
    image: { type: "string", default: process.env.RUNNER_IMAGE ?? "hardness-runner:dev" },
  },
});

function fail(message: string): never {
  process.stderr.write(`eval: ${message}\n`);
  process.exit(2);
}

const pack = PackId.safeParse(values.pack).data ?? fail(`--pack must be one of ${PackId.options.join(", ")}`);
const engineOf = (raw: string | undefined, flag: string) => EngineId.safeParse(raw).data ?? fail(`${flag} must be one of ${EngineId.options.join(", ")}`);
const engines = [engineOf(values.engine, "--engine"), ...(values.against ? [engineOf(values.against, "--against")] : [])];
// A decision's grade is its label and its confidence: no judge unless asked for.
const judge = values["no-judge"] || (PACKS[pack].kind === "decision" && !values.judge) ? null : PACKS.eval_judge.engines.default;
const trials = (() => {
  try {
    return parseTrials(values.trials);
  } catch (error) {
    return fail((error as Error).message);
  }
})();
const image = values.image!;
const credentials = machineCredentials();
// The same list a real run of the pack gets (kind agent: the engine's host, GitHub, the registries), so what is measured is what runs; MACHINE_EGRESS=off applies here too.
const egress = buildEgress({ egress: loadConfig(process.env).egress, runnerImage: image, traces: tracesFromEnv() }, new PolicyStore());

// Traces and evaluations go to the same local Laminar the machine reports to, when a key is set.
const telemetry = await buildTelemetry(tracesFromEnv());
if (telemetry.mode !== "off") console.log(`laminar: each case is a trace (${telemetry.mode}); each engine's run an evaluation in group ${pack}`);

let cases: EvalCase[];
try {
  if (values.dataset) {
    if (telemetry.mode === "off") fail("--dataset needs Laminar: set LMNR_PROJECT_API_KEY");
    const pulled = datasetCases(pack, await telemetry.datasets.pull(values.dataset));
    for (const s of pulled.skipped) console.log(`skipped ${s.taskId}: ${s.reason}`);
    cases = values.case?.length ? pulled.cases.filter((c) => values.case!.includes(c.id)) : pulled.cases;
  } else cases = loadCases(EVALS, pack, values.case ?? []);
} catch (error) {
  fail((error as Error).message);
}
if (cases.length === 0) fail(values.dataset ? `no labelled datapoints in the dataset ${values.dataset}` : `no cases under evals/${pack}/cases`);
if (!(await imageExists(image))) fail(`no image ${image}: build it with \`pnpm --filter @hardness/machine runner:build\``);
for (const engine of new Set([...engines, ...(judge ? [judge] : [])])) {
  const found = await credentials.check(engine);
  if (!found.available) fail(`${engine}: ${found.reason}`);
}
for (const engine of engines) {
  if (!PACKS[pack].engines.allowed.includes(engine)) console.log(`note: ${engine} is not in ${pack}'s allowed engines; running it as a candidate`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** One case on one engine: run it, grade it, and (when the answer is on the schema) judge it. */
async function runCase(evalCase: EvalCase, engine: EngineId, index: number, trial: number, evaluation: Evaluation): Promise<CaseResult> {
  const runDir = join(EVALS, ".runs", stamp, slug(engine), trial > 1 ? `${evalCase.id}-trial-${trial}` : evalCase.id);
  mkdirSync(runDir, { recursive: true });
  const worktree = prepareWorktree(evalCase.input, ROOT, runDir);
  const span = telemetry.run({ kind: "eval", pack, engine, client: "eval", sessionId: `eval-${pack}-${stamp}` });
  const started = Date.now();
  const run = await runPackOnce(
    { name: `hardness-eval-${slug(pack)}-${slug(evalCase.id)}-${slug(engine)}-${stamp.slice(11, 19)}${trial > 1 ? `-t${trial}` : ""}`, image, runDir, worktree, input: caseInput(evalCase.input, engine), engine, labels: { luna: "eval" }, extraEnv: span.childEnv(), egressKind: "agent" },
    { credentials, ...(egress ? { egress } : {}) },
  ).catch((error: Error) => ({ output: null, error: error.message }) as const);
  const caseRun = { id: evalCase.id, output: run.output, error: run.error, wallMs: Date.now() - started };
  const { answer, schema } = gradeAnswer(pack, evalCase.expect, caseRun);
  let verdict: JudgeVerdict | null = null;
  if (judge && schema.pass) verdict = await judgeAnswer(evalCase, answer, judge, join(runDir, "judge"));
  else if (judge) verdict = { error: "not judged: no answer on the schema" };
  const result = { ...caseResult(pack, evalCase.expect, caseRun, verdict), ...(trials > 1 ? { trial } : {}) };
  await span.end({
    outcome: result.pass ? "pass" : "fail",
    engine,
    error: run.error ?? (run.output && !run.output.ok ? outputError(run.output) : null),
    summary: run.output?.summary ?? null,
    model: result.model,
    turns: result.turns,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    info: run.output?.run ?? null,
    transcriptPath: join(runDir, "transcript.log"),
  });
  await evaluation.record(evalDatapoint(evalCase, result, answer, index, span.traceId()));
  console.log(`${result.pass ? "PASS" : "FAIL"} ${pack}/${evalCase.id}${trial > 1 ? ` (trial ${trial})` : ""} on ${engine}${verdict && "score" in verdict ? ` · judge ${verdict.score.toFixed(2)}` : ""}`);
  return result;
}

async function judgeAnswer(evalCase: EvalCase, answer: unknown, engine: EngineId, runDir: string): Promise<JudgeVerdict> {
  mkdirSync(join(runDir, "work"), { recursive: true });
  const run = await runPackOnce(
    { name: `hardness-eval-judge-${slug(evalCase.id)}-${stamp.slice(11, 19)}-${Math.random().toString(36).slice(2, 6)}`, image, runDir, worktree: join(runDir, "work"), input: judgeInput(evalCase, answer, engine), engine, labels: { luna: "eval" }, egressKind: "agent" },
    { credentials, ...(egress ? { egress } : {}) },
  ).catch((error: Error) => ({ output: null, error: error.message }) as const);
  if (run.error !== null) return { error: `judge: ${run.error}` };
  if (!run.output.ok) return { error: `judge: ${outputError(run.output)}` };
  return verdictOf(run.output.answer, run.output.usage.costUsd);
}

const cards: Scorecard[] = [];
for (const engine of engines) {
  const evaluation = await telemetry.evaluation({ name: `${engine} ${stamp.slice(0, 10)}`, groupName: pack, metadata: { pack, engine, judge, trials, cases: cases.map((c) => c.id) } });
  const results: CaseResult[] = [];
  for (const [index, evalCase] of cases.entries()) for (let trial = 1; trial <= trials; trial++) results.push(await runCase(evalCase, engine, index * trials + trial - 1, trial, evaluation));
  await evaluation.finish();
  if (evaluation.id) console.log(`laminar: evaluation ${evaluation.id} (${engine} on ${pack})`);
  const card = scorecard({ pack, engine, judge, at: new Date().toISOString(), ...(trials > 1 ? { trials } : {}) }, results);
  cards.push(card);
  writeFileSync(join(EVALS, ".runs", stamp, `${slug(engine)}-${pack}.json`), `${JSON.stringify(card, null, 2)}\n`);
}

for (const card of cards) {
  console.log(`\n${formatScorecard(card)}`);
  const path = baselinePath(EVALS, card.engine, pack);
  if (values["save-baseline"]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
    console.log(`  baseline saved: ${path.slice(ROOT.length + 1)}`);
  } else if (existsSync(path)) {
    const base = JSON.parse(readFileSync(path, "utf8")) as Scorecard;
    console.log(formatDiff(diffScorecards(base, card), `  against its baseline (${base.at.slice(0, 10)})`));
  } else {
    console.log("  no baseline yet: --save-baseline writes one");
  }
}
if (cards.length === 2) console.log(`\n${formatDiff(diffScorecards(cards[1]!, cards[0]!))}`);
await telemetry.flush();
console.log(`\nrun folders: ${join(EVALS, ".runs", stamp).slice(ROOT.length + 1)}`);
