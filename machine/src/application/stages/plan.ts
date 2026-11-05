// The plan stage, which runs in the test_design state: the planner writes the plan from triage's
// record, the test designer writes the scenarios, the machine lists the criteria no scenario names
// (never asked of a model), and three decision packs judge the result: coverage_check, plan_check
// and risk_score. Everything lands in one detail, which opens the one approval.
//
// A ticket triage sent to the fast lane (`record.decision === "fast_lane"`) runs the same stage on
// the fast packs: one designer round, no coverage_check, one plan_check, and the planner's right
// to refuse (`needs_full_plan`). A refusal, or a plan check that cannot tell whether the plan
// fits, plans again on the full path in the same run (`detail.lane`, `detail.laneNote`).
//
// Each pack runs as a sub-run of the stage's own run, under a derived run id (`<runId>-plan`,
// `<runId>-plan-<n>`, `<runId>-tests-<n>`): its own folder and container, not resumable (a
// restart re-runs the stage), and on the pack's own engine, never the stage's.
import {
  CodeMapAnswer,
  type DecisionOverrides,
  PACKS,
  type PlanContext,
  type Risk,
  type TestCase,
  type Verdict,
  applyPolicy,
  coverageGaps,
  maxRisk,
  riskLevelOf,
} from "@hardness/contracts";

import { recordIdOf } from "../decision-truth.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

/** Test designer runs per plan: the first, and two more with the criteria it missed. */
export const COVERAGE_ROUNDS = 3;
/** Planner re-runs after plan_check found something wrong. */
export const PLAN_ROUNDS = 2;

type DecisionPackName = "risk_score" | "coverage_check" | "plan_check";

export interface PlanDeps {
  /** Runs one pack as a sub-run of this stage: `context` already carries the derived run id. `extra.plan` reaches the pack as `context.plan`. */
  runPack: (pack: "plan" | "plan_fast" | "test_design" | "test_design_fast" | "code_map", context: StageContext, extra: { plan?: PlanContext }) => Promise<StageResult>;
  /** Runs a decision pack on a plan context and answers its answer; null when no decision can run (agents off, no runtime). Read at call time: main.ts binds it late. */
  decide: ((pack: DecisionPackName, plan: PlanContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null;
  /** Each repo's luna.yaml bars for the decisions. */
  policies: { for(repoPath: string | null): Promise<{ decisions: Record<string, DecisionOverrides>; graph?: boolean; factory?: { plan: { coverage_rounds: number; plan_check_retries: number } } }> };
  /** The machine's code graphs: a repo with one (and its luna.yaml `policy.graph` on) gets a code map before the plan. */
  graph?: { stampOf(repoPath: string): Promise<unknown | null> };
  log?: (line: string) => void;
}

type Judged = { verdict: Verdict | "skipped"; problems: string[]; answer: Record<string, unknown> | null; recordId?: string };

const score = (answer: Record<string, unknown>, question: string): number => Number((answer[question] as { score?: number } | undefined)?.score ?? 0);
const flag = (answer: Record<string, unknown>, question: string): boolean | null => {
  const value = (answer[question] as { value?: boolean } | undefined)?.value;
  return typeof value === "boolean" ? value : null;
};

/** What a decision's answer says is wrong, whatever its confidence: a confident "no" is a finding too. */
function problemsOf(pack: DecisionPackName, answer: Record<string, unknown>, hasMap: boolean): string[] {
  if (pack === "coverage_check") {
    return [
      ...(flag(answer, "pins") === false ? ["the scenarios do not each pin the criterion they name"] : []),
      ...(flag(answer, "untestable") === true ? ["a criterion is written so that no scenario could prove it"] : []),
      ...(score(answer, "redundancy") >= 1.5 ? ["most scenarios restate one check"] : []),
    ];
  }
  if (pack === "plan_check") {
    return [
      ...(score(answer, "fits_record") < 1.5 ? ["the plan does not build what the record's goal asks, no more and no less"] : []),
      ...(flag(answer, "slices_cover_criteria") === false ? ["a criterion appears in no slice's acceptance"] : []),
      ...(flag(answer, "rollback_stated") === false ? ["the rollback paragraph could not be followed at 2 a.m."] : []),
      // Asked of every plan, a finding only when there is a map to stay inside.
      ...(hasMap && flag(answer, "touchpoints_in_map") === false ? ["a slice touches files outside the code map"] : []),
    ];
  }
  return [];
}

/** Sums the sub-runs' facts the stage reports: events and artifacts in order, usage added, the last run's own run facts. */
function combine(results: StageResult[]): Pick<StageResult, "events" | "artifacts" | "usage" | "run" | "workspace"> {
  const events = results.flatMap((r) => r.events ?? []);
  const artifacts = results.flatMap((r) => r.artifacts ?? []);
  const used = results.filter((r) => r.usage);
  const sum = (key: "turns" | "costUsd") => used.reduce<number | null>((total, r) => (r.usage![key] === null ? total : (total ?? 0) + r.usage![key]!), null);
  const run = results.reduce<StageResult["run"]>((last, r) => (r.run ? { ...last, ...r.run } : last), undefined);
  const workspace = results.find((r) => r.workspace)?.workspace;
  return {
    ...(events.length ? { events } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(used.length ? { usage: { turns: sum("turns"), costUsd: sum("costUsd") } } : {}),
    ...(run ? { run } : {}),
    ...(workspace ? { workspace } : {}),
  };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function planStage(deps: PlanDeps): StageRunner {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (context) => {
    const { task } = context;
    const results: StageResult[] = [];
    let testRuns = 0;
    let planRuns = 0;
    // The repo's luna.yaml `plan.coverage_rounds` and `plan.plan_check_retries`; the diagram's defaults equal the constants below.
    const repoPlan = (await deps.policies.for(task.repoPath)).factory?.plan;
    const coverageRounds = repoPlan?.coverage_rounds ?? COVERAGE_ROUNDS;
    const planCheckRetries = repoPlan?.plan_check_retries ?? PLAN_ROUNDS;

    /** A sub-run's context: a derived run id, nothing that ties it to the stage's own container or engine. */
    const sub = (suffix: string): StageContext => ({ ...context, runId: `${context.runId}-${suffix}`, started: undefined, resume: undefined, engine: undefined });
    /** The stage ends as the sub-run did (needs_input, a failure, a usage limit), with what ran so far. */
    const ended = (result: StageResult): StageResult => ({ ...result, ...combine([...results, result]) });

    const judge = async (pack: DecisionPackName, plan: PlanContext): Promise<Judged> => {
      if (!deps.decide) return { verdict: "skipped", problems: [], answer: null };
      try {
        const answer = await deps.decide(pack, plan, task.repoPath);
        const overrides = (await deps.policies.for(task.repoPath)).decisions[pack];
        const { overall } = applyPolicy(PACKS[pack], answer, overrides);
        const problems = problemsOf(pack, answer, Boolean(plan.map));
        const recordId = recordIdOf(answer);
        return { verdict: overall === "proceed" && problems.length > 0 ? "flag" : overall, problems, answer, ...(recordId ? { recordId } : {}) };
      } catch (error) {
        log(`plan stage: ${pack} skipped for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { verdict: "skipped", problems: [], answer: null };
      }
    };

    // The code map opens the stage when the repo has a graph. It is advice: a failed run is logged and the stage plans without one.
    let map: CodeMapAnswer | null = null;
    if (task.repoPath && deps.graph && (await deps.policies.for(task.repoPath)).graph !== false && (await deps.graph.stampOf(task.repoPath))) {
      const mapped = await deps.runPack("code_map", sub("map"), {});
      results.push(mapped);
      const parsed = CodeMapAnswer.safeParse(mapped.detail?.map);
      if (mapped.outcome === "pass" && parsed.success) map = parsed.data;
      else log(`plan stage: code_map skipped for task ${task.id}: ${mapped.outcome === "pass" ? "no usable map" : String(mapped.detail?.error ?? mapped.outcome)}`);
    }
    const mapPart = map ? { map } : {};

    let lane: "fast" | "full" = task.record?.decision === "fast_lane" ? "fast" : "full";
    let laneNote: string | undefined;
    /** Planner runs on the current lane: the re-run cap counts from the last switch. */
    let planRunsOnLane = 0;
    /** The stage moves to the full path: the fast lane's plan is dropped, and the full planner starts from the record. */
    const goFull = (note: string) => {
      lane = "full";
      laneNote = note;
      planRunsOnLane = 0;
      review = undefined;
      plan = undefined;
      flagged.clear();
    };

    let review: string[] | undefined;
    let plan: { brief: string; criteria: string[]; assumptions: string[]; slices: PlanContext["slices"]; rollback?: string; summary?: string } | undefined;
    let cases: TestCase[] = [];
    let gaps: string[] = [];
    let coverage: Judged = { verdict: "skipped", problems: [], answer: null };
    let planCheck: Judged = { verdict: "skipped", problems: [], answer: null };
    const flagged = new Set<string>();

    for (;;) {
      // The planner: the first run, or a re-run with what plan_check found.
      planRuns += 1;
      planRunsOnLane += 1;
      const planned = await deps.runPack(lane === "fast" ? "plan_fast" : "plan", sub(planRuns === 1 ? "plan" : `plan-${planRuns}`), {
        ...(plan
          ? { plan: { record: task.record ?? null, ...plan, cases, round: planRuns, ...(review ? { review } : {}), ...mapPart } }
          : map
            ? { plan: { record: task.record ?? null, brief: "", criteria: task.criteria, assumptions: [], slices: [], map } }
            : {}),
      });
      if (planned.outcome !== "pass") return ended(planned);
      results.push(planned);
      const d = planned.detail ?? {};
      if (lane === "fast" && d.needsFullPlan === true) {
        goFull(`the fast planner asked for the full plan: ${String(d.summary ?? "the ticket is bigger than it looked")}`);
        continue;
      }
      plan = {
        brief: typeof d.brief === "string" && d.brief ? d.brief : String(d.summary ?? ""),
        criteria: strings(d.criteria).length ? strings(d.criteria) : task.criteria,
        assumptions: strings(d.assumptions),
        slices: Array.isArray(d.slices) ? (d.slices as PlanContext["slices"]) : [],
        ...(typeof d.rollback === "string" ? { rollback: d.rollback } : {}),
        ...(typeof d.summary === "string" ? { summary: d.summary } : {}),
      };

      // The test designer, told the criteria it missed until none is left or the rounds run out.
      let roundsOnThisPlan = 0;
      gaps = [];
      cases = [];
      coverage = { verdict: "skipped", problems: [], answer: null };
      for (;;) {
        roundsOnThisPlan += 1;
        testRuns += 1;
        const designed = await deps.runPack(lane === "fast" ? "test_design_fast" : "test_design", sub(`tests-${testRuns}`), {
          plan: { record: task.record ?? null, ...plan, ...(cases.length ? { cases } : {}), ...(gaps.length ? { gaps } : {}), round: roundsOnThisPlan, ...mapPart },
        });
        if (designed.outcome !== "pass") return ended(designed);
        results.push(designed);
        cases = ((designed.detail?.cases as TestCase[] | undefined) ?? []).filter((c) => c && typeof c === "object");
        gaps = coverageGaps(plan.criteria, cases);
        // The fast lane asks nothing of coverage_check and designs once: a criterion left unnamed is flagged below.
        if (lane === "fast") break;
        coverage = await judge("coverage_check", { record: task.record ?? null, ...plan, cases, ...(gaps.length ? { gaps } : {}), ...mapPart });
        if (gaps.length === 0 || roundsOnThisPlan >= coverageRounds) break;
      }
      if (lane === "fast" && gaps.length > 0) flagged.add("coverage");
      if (gaps.length > 0 && coverage.verdict === "proceed") coverage = { ...coverage, verdict: "flag" };

      // The plan against the record: a finding sends the planner back, within the cap.
      planCheck = await judge("plan_check", { record: task.record ?? null, ...plan, cases, ...(gaps.length ? { gaps } : {}), ...mapPart });
      if (lane === "fast") {
        // One plan check, no re-run: unsure whether the plan fits means the ticket needs the full path.
        if (planCheck.verdict !== "ask") break;
        goFull("the plan check could not tell whether the fast plan fits the record; planned again in full");
        continue;
      }
      const wrong = planCheck.problems.length > 0 || planCheck.verdict === "ask";
      if (!wrong || planRunsOnLane > planCheckRetries) break;
      review = planCheck.problems.length ? planCheck.problems : ["the plan check could not tell whether the plan fits the record"];
    }

    const riskJudged = await judge("risk_score", { record: task.record ?? null, ...plan, cases, ...(gaps.length ? { gaps } : {}), ...mapPart });
    const answer = riskJudged.answer;
    const scores = answer ? { blast_radius: score(answer, "blast_radius"), reversibility: score(answer, "reversibility"), data_sensitivity: score(answer, "data_sensitivity") } : {};
    // The decision may raise the risk above triage's grade, never lower it: one small-model call must not drop the second approver.
    const graded: Risk = task.record?.risk ?? "medium";
    const level: Risk = answer ? maxRisk(riskLevelOf(answer as Parameters<typeof riskLevelOf>[0]), graded) : graded;

    const verdicts = { coverage: coverage.verdict, plan: planCheck.verdict, risk: riskJudged.verdict };
    for (const [name, verdict] of Object.entries(verdicts)) if (verdict === "flag" || verdict === "ask") flagged.add(name);

    return {
      outcome: "pass",
      ...combine(results),
      detail: {
        summary: plan!.summary ?? plan!.brief,
        brief: plan!.brief,
        criteria: plan!.criteria,
        assumptions: plan!.assumptions,
        slices: plan!.slices,
        ...(plan!.rollback !== undefined ? { rollback: plan!.rollback } : {}),
        cases,
        risk: { level, scores },
        verdicts,
        // The decisions' records, so the gate's outcome can be written onto them (decision-truth.ts).
        decisions: Object.fromEntries(([["coverage_check", coverage], ["plan_check", planCheck], ["risk_score", riskJudged]] as const).flatMap(([pack, judged]) => (judged.recordId ? [[pack, judged.recordId]] : []))),
        rounds: { tests: testRuns, plan: planRuns },
        flagged: [...flagged],
        map,
        lane,
        ...(laneNote ? { laneNote } : {}),
      },
    };
  };
}
