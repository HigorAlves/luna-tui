// How deep a PR's review goes: pr_risk reads the PR's files and line counts (no diff) and says low, medium or high, and the risk picks what the main
// reviewer and the passes are asked to run on (`REVIEW_DEPTH`). luna.yaml's `engines:` and `effort:` always win: a pack the repo names is left alone.
import { type DecisionOverrides, type EngineId, type Effort, PACKS, REVIEW_DEPTH, REVIEW_HELPER_PACKS, type ReviewHelperPack, type StageEfforts, type StageEngines, applyPolicy } from "@hardness/contracts";

import { decidedBy } from "../decision-truth.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";

export type Risk = "low" | "medium" | "high";
export interface Suggested {
  engine?: EngineId;
  effort?: Effort;
}

export interface RiskDeps {
  decide: Decide | null;
  decisions?: Record<string, DecisionOverrides>;
  /** The repo's luna.yaml engines and efforts: what it names is never suggested over. */
  policy?: { engines?: StageEngines | null; effort?: StageEfforts | null };
  /** Whether this machine can run an engine now (its login is present). Absent, none is ready. */
  engineReady?: (engine: EngineId) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface RiskRead {
  level: Risk;
  by: "jev" | "fallback" | "skipped";
  /** What the main reviewer is asked to use; absent for none. */
  main?: Suggested;
  /** What each pass is asked to use. */
  passes: Partial<Record<ReviewHelperPack, Suggested>>;
  /** What came of the read, for the card: the suggestions that applied after luna.yaml, and the second opinion's engine. */
  applied: { main?: Suggested; passes?: Suggested; second?: EngineId };
}

const FILES = 200;
/** The engines a second opinion on another family may run on, the stronger first. */
const SECOND_OPINION: EngineId[] = ["codex:sol", "codex:luna"];

/** The PR's files as the decision reads them: the biggest changes first, at most 200, with the totals. */
export function riskCheck(title: string, scope: string, files: ReadonlyArray<{ path: string; additions: number; deletions: number }>) {
  const biggest = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, FILES);
  return {
    kind: "pr_risk" as const,
    risk: {
      title: title.slice(0, 300),
      scope,
      files: biggest.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      filesTotal: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
  };
}

/** A confident low, or a high that is at least flagged; anything else is medium (today's depth). */
export function riskLevelOf(answer: Record<string, unknown> | null, overrides: DecisionOverrides | undefined): Risk {
  if (!answer) return "medium";
  const choice = (answer.level as { choice?: unknown } | undefined)?.choice;
  const verdict = applyPolicy(PACKS.pr_risk, answer, overrides ?? {}).verdicts.level;
  if (choice === "high" && (verdict === "proceed" || verdict === "flag")) return "high";
  if (choice === "low" && verdict === "proceed") return "low";
  return "medium";
}

const empty = (s: Suggested): boolean => s.engine === undefined && s.effort === undefined;

export async function readRisk(deps: RiskDeps, input: { title: string; files: ReadonlyArray<{ path: string; additions: number; deletions: number }>; repoPath: string | null }): Promise<RiskRead> {
  const overrides = deps.decisions ?? {};
  const { answer } = await judgeCheck(deps.decide, "pr_risk", riskCheck(input.title, "the whole PR", input.files), input.repoPath, overrides, deps.log);
  const level = riskLevelOf(answer, overrides.pr_risk);
  const depth = REVIEW_DEPTH[level];
  const engines = deps.policy?.engines ?? {};
  const efforts = deps.policy?.effort ?? {};
  // What luna.yaml names is the repo's; the rest is the risk's.
  const main: Suggested = { ...(depth.main.effort && !efforts.reviewing ? { effort: depth.main.effort } : {}) };
  const passes: Partial<Record<ReviewHelperPack, Suggested>> = {};
  for (const pack of REVIEW_HELPER_PACKS) {
    const s: Suggested = { ...(depth.passes.engine && !engines[pack] ? { engine: depth.passes.engine } : {}), ...(depth.passes.effort && !efforts[pack] ? { effort: depth.passes.effort } : {}) };
    if (!empty(s)) passes[pack] = s;
  }
  let second: EngineId | undefined;
  if (depth.second && !engines.review_second && deps.engineReady) {
    for (const engine of SECOND_OPINION) {
      if (await deps.engineReady(engine).catch(() => false)) {
        second = engine;
        break;
      }
    }
    if (second) passes.review_second = { ...passes.review_second, engine: second };
  }
  return {
    level,
    by: decidedBy(answer),
    ...(empty(main) ? {} : { main }),
    passes,
    applied: { ...(empty(main) ? {} : { main }), ...(empty(depth.passes) ? {} : { passes: depth.passes }), ...(second ? { second } : {}) },
  };
}
