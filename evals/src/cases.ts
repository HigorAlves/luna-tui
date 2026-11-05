// The cases on disk, what each case's container is given, and the judge's input. A case is
// `evals/<pack>/cases/<id>/stage.json` (a StageInput) and `expect.json`; a case that needs a
// repo names a fixture as its `task.repoPath` (`fixtures/golden-task`), copied fresh per run
// without `.golden/`, which holds the reference fixes and hidden tests no model may see.
import { type EngineId, EvalJudgeAnswer, PACK_LIMITS, type PackId, StageInput } from "@hardness/contracts";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Datapoint } from "@hardness/machine/telemetry";

import { casesOfDatapoints } from "./datasets.ts";
import { Expect } from "./expect.ts";
import type { JudgeVerdict } from "./grade.ts";

export interface EvalCase {
  id: string;
  pack: PackId;
  input: StageInput;
  expect: Expect;
}

/** The prefix a case's `task.repoPath` carries when it runs over a fixture repo. */
export const FIXTURE_PREFIX = "fixtures/";
/** What a fixture copy never carries. */
const HIDDEN = /[\\/](\.golden|node_modules|\.git)([\\/]|$)/;

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Every case of `pack` under `evalsDir` (or the ones named), validated; a bad case throws with its path. */
export function loadCases(evalsDir: string, pack: PackId, only: string[] = []): EvalCase[] {
  const dir = join(evalsDir, pack, "cases");
  const ids = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new Error(`no ${pack} case named ${missing.join(", ")} (have: ${ids.join(", ") || "none"})`);
  return ids
    .filter((id) => only.length === 0 || only.includes(id))
    .map((id) => {
      const where = join(dir, id);
      const input = StageInput.safeParse(readJson(join(where, "stage.json")));
      if (!input.success) throw new Error(`${where}/stage.json: ${input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      if (input.data.pack !== pack) throw new Error(`${where}/stage.json: pack ${input.data.pack}, but the case is under ${pack}`);
      const expect = Expect.safeParse(readJson(join(where, "expect.json")));
      if (!expect.success) throw new Error(`${where}/expect.json: ${expect.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return { id, pack, input: input.data, expect: expect.data };
    });
}

/** The folder mounted at /work for a case: an empty one, or a fresh git repo made from its fixture. */
export function prepareWorktree(input: StageInput, repoRoot: string, runDir: string): string {
  const work = join(runDir, "work");
  mkdirSync(work, { recursive: true });
  const repo = input.task.repoPath;
  if (!repo.startsWith(FIXTURE_PREFIX)) return work;
  const fixture = join(repoRoot, repo);
  if (!existsSync(fixture)) throw new Error(`fixture ${repo} not found under ${repoRoot}`);
  cpSync(fixture, work, { recursive: true, filter: (src) => !HIDDEN.test(src.slice(fixture.length)) });
  if (existsSync(join(work, ".golden"))) throw new Error(`refusing to run: ${work}/.golden survived the copy`);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=evals", "-c", "user.email=evals@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: work, stdio: "ignore" });
  git("init", "-q", "-b", input.task.branch || "main");
  git("add", "-A");
  git("commit", "-q", "-m", `seed: ${repo}`);
  return work;
}

/** The case's input as it runs today: on `engine`, with the pack's current limits. */
export function caseInput(input: StageInput, engine: EngineId): StageInput {
  const { maxTurns, timeoutMs } = PACK_LIMITS[input.pack];
  return { ...input, engine, limits: { maxTurns, timeoutMs } };
}

/** What the judge reads about one case and one answer. */
export function judgeInput(evalCase: EvalCase, answer: unknown, engine: EngineId): StageInput {
  const { task, plan, decisions, context } = evalCase.input;
  const { maxTurns, timeoutMs } = PACK_LIMITS.eval_judge;
  return {
    schema: 3,
    stage: "eval_judge",
    pack: "eval_judge",
    engine,
    attempt: 1,
    task: { id: `eval-${evalCase.pack}-${evalCase.id}`, title: `Judge ${evalCase.pack}/${evalCase.id}`, description: "", criteria: [], repoPath: "", branch: "", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: {
      projectContext: null,
      eval: {
        pack: evalCase.pack,
        caseId: evalCase.id,
        rubric: evalCase.expect.rubric,
        input: JSON.stringify({ task, plan, decisions, context }, null, 2),
        checks: JSON.stringify(evalCase.expect.checks, null, 2),
        answer: JSON.stringify(answer, null, 2),
      },
    },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}

/** The judge's verdict from its run's answer, or why there is none. */
export function verdictOf(answer: unknown, costUsd: number | null): JudgeVerdict {
  const parsed = EvalJudgeAnswer.safeParse(answer);
  if (!parsed.success) return { error: `the judge's answer is off its schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { ...parsed.data, costUsd };
}

/** Where an engine's baseline for a pack lives: `baselines/<engine>/<pack>.json`, `:` as `-` so it checks out anywhere. */
export function baselinePath(evalsDir: string, engine: EngineId, pack: PackId): string {
  return join(evalsDir, "baselines", engine.replaceAll(":", "-"), `${pack}.json`);
}

/** Cases from a Laminar dataset's datapoints, for grading what a person labelled before it is committed: each parsed with the pack's context schema, a bad one reported and skipped. */
export function datasetCases(pack: PackId, datapoints: Datapoint[]): { cases: EvalCase[]; skipped: Array<{ taskId: string; reason: string }> } {
  const { cases, skipped } = casesOfDatapoints(pack, datapoints);
  return { cases: cases.map((c) => ({ id: c.id, pack, input: c.stage, expect: c.expect })), skipped };
}

/** `--trials`: a whole number from 1 to 20. */
export function parseTrials(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--trials must be a whole number from 1 to 20");
  return n;
}
