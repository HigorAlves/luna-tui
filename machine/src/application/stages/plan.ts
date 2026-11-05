// The plan stage, which runs in the test_design state: the planner writes the plan from triage's
// record, the test designer writes the scenarios, the machine lists the criteria no scenario names
// (never asked of a model), and three decision packs judge the result: coverage_check, plan_check
// and risk_score, which runs first. Everything lands in one detail, which opens the one approval.
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
  FACTORY_DEFAULTS,
  type FactoryConfig,
  PACKS,
  type PlanContext,
  type PlanRisk,
  type PlanStep,
  type Risk,
  type TestCase,
  type Verdict,
  applyPolicy,
  type Coverage,
  coverageOf,
  isPlainRepoPath,
  planFacts,
  criteriaOf,
  maxRisk,
  planOf,
  riskOf,
} from "@hardness/contracts";

import type { RequiredOwners } from "../../domain/codeowners.ts";
import type { GraphLocation } from "../graph.ts";
import { approvalRule } from "../../domain/approvers.ts";
import { controlPlaneFiles } from "../../domain/control-plane.ts";
import { triageVerdicts } from "../../domain/triage-policy.ts";
import { recordIdOf } from "../decision-truth.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

/** Test designer runs per plan: the first, and two more with the criteria it missed. */
export const COVERAGE_ROUNDS = 3;
/** Planner re-runs after plan_check found something wrong. */
export const PLAN_ROUNDS = 2;

/** Questions an answer may leave out (an answer stored before they existed, or an engine that skipped one): the rest is still judged. */
const OPTIONAL_QUESTIONS: Partial<Record<DecisionPackName, string[]>> = { risk_score: ["complexity"], plan_check: ["risk_appropriate"] };

type DecisionPackName = "risk_score" | "coverage_check" | "plan_check";

export interface PlanDeps {
  /** Runs one pack as a sub-run of this stage: `context` already carries the derived run id. `extra.plan` reaches the pack as `context.plan`. */
  runPack: (pack: "plan" | "plan_fast" | "test_design" | "test_design_fast" | "code_map", context: StageContext, extra: { plan?: PlanContext }) => Promise<StageResult>;
  /** Runs a decision pack on a plan context and answers its answer; null when no decision can run (agents off, no runtime). Read at call time: main.ts binds it late. */
  decide: ((pack: DecisionPackName, plan: PlanContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null;
  /** Each repo's luna.yaml bars for the decisions. */
  policies: { for(repoPath: string | null): Promise<{ decisions: Record<string, DecisionOverrides>; graph?: boolean; factory?: { fast_lane?: FactoryConfig["fast_lane"]; plan: { coverage_rounds: number; plan_check_retries: number; coverage_score_min?: number; approvers?: FactoryConfig["plan"]["approvers"] }; triage?: FactoryConfig["triage"]; graph?: FactoryConfig["graph"] } }> };
  /** The machine's code graphs: a repo with one (and its luna.yaml `policy.graph` on) gets a code map before the plan. */
  graph?: {
    stampOf(repoPath: string): Promise<unknown | null>;
    /** Where the goal's words point in the graph, with who owns it and how stale the graph is; null when there is none. Seeds the mapper and marks the map. */
    locate?(repoPath: string, text: string, options?: { staleCommits?: number }): Promise<GraphLocation | null>;
    /** Who owns these paths at the default branch (CODEOWNERS); null when the repo has no graph. The fast lane asks it about the plan's own files. */
    owners?(repoPath: string, paths: string[]): Promise<{ owners: RequiredOwners[]; codeowners: boolean } | null>;
  };
  log?: (line: string) => void;
}

type Judged = { verdict: Verdict | "skipped"; problems: string[]; answer: Record<string, unknown> | null; recordId?: string; verdicts?: Record<string, Verdict> };

const score = (answer: Record<string, unknown>, question: string): number => Number((answer[question] as { score?: number } | undefined)?.score ?? 0);
const flag = (answer: Record<string, unknown>, question: string): boolean | null => {
  const value = (answer[question] as { value?: boolean } | undefined)?.value;
  return typeof value === "boolean" ? value : null;
};

/** What a decision's answer says is wrong, whatever its confidence: a confident "no" is a finding too. */
function problemsOf(pack: DecisionPackName, answer: Record<string, unknown>): string[] {
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
      ...(flag(answer, "risk_appropriate") === false ? ["the plan is not appropriate to its risk level: a high-risk plan names a migration or a flag strategy and keeps its steps small"] : []),
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
    const coverageBar = repoPlan?.coverage_score_min ?? FACTORY_DEFAULTS.plan.coverage_score_min;
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
        // An answer stored before a question existed, or from an engine that left an optional one out, is judged on what it has:
        // risk_score's complexity is advice, and its absence must not cost the card its risk score.
        const asked = PACKS[pack];
        const optional = OPTIONAL_QUESTIONS[pack] ?? [];
        const questions = Object.fromEntries(Object.entries(asked.questions).filter(([name]) => !optional.includes(name) || answer[name] !== undefined));
        const { overall, verdicts } = applyPolicy({ questions, policy: asked.policy }, answer, overrides);
        const problems = problemsOf(pack, answer);
        const recordId = recordIdOf(answer);
        return { verdict: overall === "proceed" && problems.length > 0 ? "flag" : overall, problems, answer, verdicts, ...(recordId ? { recordId } : {}) };
      } catch (error) {
        log(`plan stage: ${pack} skipped for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { verdict: "skipped", problems: [], answer: null };
      }
    };

    // The code map opens the stage when the repo has a graph. It is advice: a failed run is logged and the stage plans without one.
    // The machine first matches the goal against the graph (a script, `locate`) and hands the shortlist to the mapper, which confirms it and gives
    // each file a role. The fast lane stops at `locate`: no agent, no impact walk; its map is what locate found, every file to change.
    // A fast lane that turns into a full plan runs the agent then, in the same stage run.
    let map: CodeMapAnswer | null = null;
    let mapNote: string | undefined = "the repo has no code graph, so there is no code map";
    let located: GraphLocation | null = null;
    const graphOn = async () => Boolean(task.repoPath && deps.graph && (await deps.policies.for(task.repoPath)).graph !== false && (await deps.graph.stampOf(task.repoPath!)));
    const locateGoal = async (): Promise<GraphLocation | null> => {
      const repoConfig = (await deps.policies.for(task.repoPath)).factory;
      return deps.graph?.locate
        ? await deps.graph.locate(task.repoPath!, `${task.title}\n${task.description}`, { staleCommits: repoConfig?.graph?.stale_commits ?? FACTORY_DEFAULTS.graph.stale_commits }).catch((error: unknown) => {
            log(`plan stage: locate skipped for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          })
        : null;
    };
    const mapFromLocate = (found: GraphLocation): CodeMapAnswer | null =>
      found.files.length === 0
        ? null
        : capMap({ components: found.components, files: found.files.map((path) => ({ path, role: "change" as const })), entry_points: [], owners: [...new Set(found.owners.flatMap((o) => o.owners))], confidence: found.confidence, stale: found.stale, behind: found.behind });
    /** What the machine stores of a map: the first 40 files and entry points, plain repo-relative paths only (what is not is kept by name for the plan check). Truncates, never rejects. */
    const MAP_CAP = 40;
    const capMap = (m: CodeMapAnswer): CodeMapAnswer => {
      const files = m.files.filter((f) => isPlainRepoPath(f.path));
      const entry = m.entry_points.filter((e) => isPlainRepoPath(e));
      const dropped = [...m.files.filter((f) => !isPlainRepoPath(f.path)).map((f) => f.path), ...m.entry_points.filter((e) => !isPlainRepoPath(e))].map((p) => p.replace(/\s+/g, " ").slice(0, 100));
      return { ...m, files: files.slice(0, MAP_CAP), entry_points: entry.slice(0, MAP_CAP), ...(dropped.length || m.dropped?.length ? { dropped: [...new Set([...(m.dropped ?? []), ...dropped])] } : {}) };
    };
    const mapWithAgent = async (found: GraphLocation | null) => {
      const shortlist = found ? { files: found.files, symbols: found.symbols, components: found.components, owners: [...new Set(found.owners.flatMap((o) => o.owners))] } : undefined;
      const mapped = await deps.runPack("code_map", sub("map"), shortlist ? { plan: { record: task.record ?? null, brief: "", criteria: task.criteria, assumptions: [], slices: [], shortlist } } : {});
      results.push(mapped);
      const parsed = CodeMapAnswer.safeParse(mapped.detail?.map);
      if (mapped.outcome === "pass" && parsed.success) {
        // The machine, not the agent, says whether the graph the map came from is stale.
        map = capMap({ ...parsed.data, ...(found ? { stale: found.stale, behind: found.behind } : {}) });
        mapNote = undefined;
      } else {
        map = null;
        mapNote = "the code map could not be made, so the plan was written without one";
        log(`plan stage: code_map skipped for task ${task.id}: ${mapped.outcome === "pass" ? "no usable map" : String(mapped.detail?.error ?? mapped.outcome)}`);
      }
    };
    let fastFirst = task.record?.decision === "fast_lane";
    if (await graphOn()) {
      located = await locateGoal();
      if (fastFirst) {
        map = located ? mapFromLocate(located) : null;
        mapNote = map ? undefined : "the fast lane found no file the code graph names, so there is no code map";
      } else await mapWithAgent(located);
    }
    /** The fast lane plans in full: the code map agent runs now, over what locate found. */
    const fullMap = async () => {
      if (fastFirst && (await graphOn())) await mapWithAgent(located);
      fastFirst = false;
    };
    const mapPart = () => (map ? { map } : {});

    // risk_score runs before the plan, on the record and the code map: the planner writes for the risk it is given.
    const riskJudged = await judge("risk_score", { record: task.record ?? null, brief: "", criteria: task.criteria, assumptions: [], slices: [], ...mapPart() });
    const answer = riskJudged.answer;
    const scores = answer ? { blast_radius: score(answer, "blast_radius"), reversibility: score(answer, "reversibility"), data_sensitivity: score(answer, "data_sensitivity") } : {};
    const complexity = (answer?.complexity as { choice?: string } | undefined)?.choice;
    // The decision may raise the risk above triage's grade, never lower it: one small-model call must not drop the second approver.
    const graded: Risk = task.record?.risk ?? "medium";
    const scored = answer ? riskOf(answer as Parameters<typeof riskOf>[0]) : null;
    let level: Risk = scored ? maxRisk(scored.level, graded) : graded;
    let risk: PlanRisk = { level, machine: level, ...(scored ? { product: scored.product, scores } : { scores }), ...(complexity === "S" || complexity === "M" || complexity === "L" || complexity === "XL" ? { complexity } : {}) };
    const riskPart = { risk };
    // A plan found wrong in Build, Verify or review comes back with its evidence: the planner's alone.
    const replanPart = context.replan ? { replan: context.replan } : {};

    let lane: "fast" | "full" = task.record?.decision === "fast_lane" ? "fast" : "full";
    let laneNote: string | undefined;
    /** Planner runs on the current lane: the re-run cap counts from the last switch. */
    let planRunsOnLane = 0;
    /** Why the fast plan's owners could not be checked, when they could not; stays on the gate. */
    let ownersFlag: string | undefined;
    let ownersRechecked = false;
    /** The stage moves to the full path: the fast lane's plan is dropped, and the full planner starts from the record. */
    const goFull = async (note: string) => {
      await fullMap();
      ownersFlag = undefined;
      lane = "full";
      laneNote = note;
      planRunsOnLane = 0;
      review = undefined;
      plan = undefined;
      extras = { outOfScope: [] };
      flagged.clear();
    };

    let review: string[] | undefined;
    let plan: { brief: string; criteria: string[]; assumptions: string[]; slices: PlanContext["slices"]; rollback?: string; summary?: string } | undefined;
    /** What the v2.2 planner wrote beside the slices: the steps with their files and done-when, out of scope, migration, flags. */
    let extras: { steps?: PlanStep[]; outOfScope: string[]; migration?: string; flags?: string[] } = { outOfScope: [] };
    let cases: TestCase[] = [];
    let gaps: string[] = [];
    /** What coverage found wrong with the last scenarios, told to the designer's next round and shown at the gate when rounds ran out. */
    let notes: string[] = [];
    let planIssues: string[] = [];
    /** What a re-planned plan says it changed from the one found wrong. */
    let changed: string | undefined;
    let finalPlan: ReturnType<typeof planOf> | undefined;
    let report: Coverage = coverageOf([], []);
    let coverage: Judged = { verdict: "skipped", problems: [], answer: null };
    let planCheck: Judged = { verdict: "skipped", problems: [], answer: null };
    const flagged = new Set<string>();

    for (;;) {
      // The planner: the first run, or a re-run with what plan_check found.
      planRuns += 1;
      planRunsOnLane += 1;
      const planned = await deps.runPack(lane === "fast" ? "plan_fast" : "plan", sub(planRuns === 1 ? "plan" : `plan-${planRuns}`), {
        ...(plan
          ? { plan: { record: task.record ?? null, ...plan, cases, round: planRuns, ...(review ? { review } : {}), ...mapPart(), ...riskPart, ...replanPart } }
          : { plan: { record: task.record ?? null, brief: "", criteria: task.criteria, assumptions: [], slices: [], ...mapPart(), ...riskPart, ...replanPart } }),
      });
      if (planned.outcome !== "pass") return ended(planned);
      results.push(planned);
      const d = planned.detail ?? {};
      if (lane === "fast" && d.needsFullPlan === true) {
        await goFull(`the fast planner asked for the full plan: ${String(d.summary ?? "the ticket is bigger than it looked")}`);
        continue;
      }
      if (typeof d.changed === "string") changed = d.changed;
      extras = {
        ...(Array.isArray(d.steps) ? { steps: d.steps as PlanStep[] } : {}),
        outOfScope: strings(d.outOfScope),
        ...(typeof d.migration === "string" ? { migration: d.migration } : {}),
        ...(Array.isArray(d.flags) ? { flags: strings(d.flags) } : {}),
      };
      plan = {
        brief: typeof d.brief === "string" && d.brief ? d.brief : String(d.summary ?? ""),
        criteria: strings(d.criteria).length ? strings(d.criteria) : task.criteria,
        assumptions: strings(d.assumptions),
        slices: Array.isArray(d.slices) ? (d.slices as PlanContext["slices"]) : [],
        ...(typeof d.rollback === "string" ? { rollback: d.rollback } : {}),
        ...(typeof d.summary === "string" ? { summary: d.summary } : {}),
      };

      // The fast lane's owners are asked about again from the plan's own files, never the ticket's words: more than one owning team leaves the lane.
      if (lane === "fast" && deps.graph) {
        const paths = [...new Set((extras.steps ? extras.steps.flatMap((st) => st.files ?? st.touchpoints) : plan.slices.flatMap((sl) => sl.touchpoints)))];
        const config = (await deps.policies.for(task.repoPath)).factory?.fast_lane ?? FACTORY_DEFAULTS.fast_lane;
        let verdict: { cross: number } | { why: string } | null = null;
        if (!deps.graph.owners) verdict = { why: "the owners could not be checked" };
        else {
          const found = await deps.graph.owners(task.repoPath!, paths).catch((): "failed" => "failed");
          if (found === "failed") verdict = { why: "the code graph could not be asked" };
          else if (found === null) verdict = { why: "no code graph" };
          else if (paths.length === 0) verdict = { why: "the fast plan names no file" };
          else if (!found.codeowners) verdict = { why: "the repository has no CODEOWNERS" };
          else {
            const teams = new Set(found.owners.flatMap((o) => o.owners)).size;
            if (teams > 1 && !config.cross_team) verdict = { cross: teams };
          }
        }
        ownersRechecked = true;
        if (verdict && "cross" in verdict) {
          await goFull(`the fast plan's own files reach ${verdict.cross} owning teams; planned in full`);
          continue;
        }
        ownersFlag = verdict?.why;
      }

      // The test designer, told the criteria it missed until none is left or the rounds run out.
      let roundsOnThisPlan = 0;
      gaps = [];
      notes = [];
      cases = [];
      coverage = { verdict: "skipped", problems: [], answer: null };
      const criteria = criteriaOf(plan.criteria);
      const textOf = (ids: string[]) => ids.map((id) => criteria.find((c) => c.id === id)?.text ?? id);
      for (;;) {
        roundsOnThisPlan += 1;
        testRuns += 1;
        const designed = await deps.runPack(lane === "fast" ? "test_design_fast" : "test_design", sub(`tests-${testRuns}`), {
          // The designer reads the criteria and the goal only: no steps, brief, assumptions, map or risk.
          plan: { record: task.record ?? null, brief: "", criteria: plan.criteria, assumptions: [], slices: [], ...(cases.length ? { cases } : {}), ...(gaps.length ? { gaps } : {}), ...(notes.length ? { coverage_notes: notes } : {}), round: roundsOnThisPlan },
        });
        if (designed.outcome !== "pass") return ended(designed);
        results.push(designed);
        cases = ((designed.detail?.cases as TestCase[] | undefined) ?? []).filter((c) => c && typeof c === "object");
        report = coverageOf(criteria, cases);
        gaps = textOf(report.gaps);
        notes = [];
        // The fast lane asks nothing of coverage_check and designs once: a criterion left unnamed is flagged below.
        if (lane === "fast") break;
        // coverage_check reads ids only: the criteria with their ids and the scenarios, no steps, brief, map, risk or record.
        coverage = await judge("coverage_check", { record: null, brief: "", criteria: plan.criteria, assumptions: [], slices: [], cases });
        // A typed decision cannot name a criterion: a confident "untestable" leaves the criteria with no scenario out of the score and the loop.
        const untestable = coverage.answer && flag(coverage.answer, "untestable") === true && coverage.verdicts?.untestable === "proceed" ? report.gaps : [];
        report = coverageOf(criteria, cases, { untestable });
        const open = report.gaps.filter((id) => !untestable.includes(id));
        gaps = textOf(open);
        const notPinned = coverage.answer && flag(coverage.answer, "pins") === false && coverage.verdicts?.pins === "proceed";
        notes = [
          ...open.map((id) => `${id} has no scenario: ${textOf([id])[0]}`),
          ...report.thin.map((id) => `${id} names a limit or an error and has no edge or failure scenario: ${textOf([id])[0]}`),
          ...(notPinned ? ["the scenarios do not each pin the criterion they name: make each fail if its criterion were not met"] : []),
        ];
        if ((notes.length === 0 && report.score >= coverageBar) || roundsOnThisPlan >= coverageRounds) break;
      }
      const underBar = report.score < coverageBar;
      if (lane === "fast" && report.gaps.length > 0) flagged.add("coverage");
      if ((gaps.length > 0 || notes.length > 0 || underBar) && coverage.verdict === "proceed") coverage = { ...coverage, verdict: "flag" };

      // The plan against the record: a finding sends the planner back, within the cap.
      // The facts by script, then the two things a script cannot judge, asked of the record, the scenarios, the map, the risk and the steps:
      // never the plan's own brief, assumptions or rollback.
      const planDoc = planOf({ brief: plan.brief, criteria: plan.criteria, assumptions: plan.assumptions, slices: extras.steps ?? plan.slices, rollback: plan.rollback, outOfScope: extras.outOfScope, version: planRuns, ...(extras.migration !== undefined ? { migration: extras.migration } : {}), ...(extras.flags !== undefined ? { flags: extras.flags } : {}) });
      const facts = planFacts(planDoc, cases, map);
      const judgedCheck = await judge("plan_check", { record: task.record ?? null, brief: "", criteria: plan.criteria, assumptions: [], slices: plan.slices, cases, ...mapPart(), ...riskPart });
      const problems = [...facts.issues, ...judgedCheck.problems];
      planCheck = { ...judgedCheck, problems, verdict: judgedCheck.verdict === "proceed" && facts.issues.length > 0 ? "flag" : judgedCheck.verdict };
      planIssues = facts.issues;
      finalPlan = planDoc;
      if (lane === "fast") {
        // One plan check, no re-run: unsure whether the plan fits means the ticket needs the full path.
        if (planCheck.verdict !== "ask") break;
        await goFull("the plan check could not tell whether the fast plan fits the record; planned again in full");
        continue;
      }
      const wrong = planCheck.problems.length > 0 || planCheck.verdict === "ask";
      if (!wrong || planRunsOnLane > planCheckRetries) break;
      review = planCheck.problems.length ? planCheck.problems : ["the plan check could not tell whether the plan fits the record"];
    }

    // The risk was fixed before the plan, so the files the planner named could not raise it: a script reads them now. A step that touches the
    // control plane (CI, ownership, luna.yaml, a lockfile) makes the plan high risk, whatever its ticket reads like; the raised level is what the
    // approvers rule and Ship read, and the machine's own floor from here on.
    const stepFiles = (finalPlan?.steps ?? []).flatMap((s) => s.files ?? s.touchpoints);
    const control = controlPlaneFiles(stepFiles);
    let riskRaised: string | undefined;
    if (control.length > 0 && level !== "high") {
      level = "high";
      risk = { ...risk, level: "high", machine: "high" };
      riskRaised = `a step touches a control-plane file: ${control.slice(0, 5).join(", ")}`;
    }
    // Step files outside the map's change and test files (a file it marks read, or does not name) and not declared new are flagged.
    if (map) {
      const allowed = new Set(map.files.filter((f) => f.role !== "read").map((f) => f.path.replace(/^(\.\/)+/, "")));
      const created = new Set((finalPlan?.steps ?? []).flatMap((s) => s.new_files ?? []).map((f) => f.replace(/^(\.\/)+/, "")));
      if (stepFiles.some((f) => !allowed.has(f.replace(/^(\.\/)+/, "")) && !created.has(f.replace(/^(\.\/)+/, "")))) flagged.add("plan outside map");
    }

    const verdicts = { coverage: coverage.verdict, plan: planCheck.verdict, risk: riskJudged.verdict };
    for (const [name, verdict] of Object.entries(verdicts)) if (verdict === "flag" || verdict === "ask") flagged.add(name);
    if (map?.stale) flagged.add("map stale");
    if (context.replan && !changed?.trim()) flagged.add("replan: the planner did not say what it changed");
    // A fast lane whose owners could not be looked at says so at the gate: the plan's own files were asked about when the graph can; else triage's note stays.
    if (lane === "fast" && ownersFlag) flagged.add(`owners not checked: ${ownersFlag}`);
    else if (lane === "fast" && task.record?.decision === "fast_lane" && task.record.ownersNotChecked && ownersFlag === undefined && !ownersRechecked) flagged.add(`owners not checked: ${task.record.ownersNotChecked}`);
    // The triage signals the person did not settle and the machine let through: shown at this gate as `triage.<field>`.
    if (task.classification) {
      const repo = await deps.policies.for(task.repoPath);
      const triage = triageVerdicts(task.classification, repo.factory?.triage ?? FACTORY_DEFAULTS.triage, { ...(repo.decisions.triage_signals ? { overrides: repo.decisions.triage_signals } : {}) });
      for (const v of Object.values(triage)) if (v.verdict !== "proceed") flagged.add(`triage.${v.field}`);
    }

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
        // The v2.2 Plan, beside the keys an open gate from before this wave carries. Its version is the planner's run count.
        plan: finalPlan!,
        // What the plan check's script found wrong with the plan, still open when the planner's re-runs ran out.
        planIssues,
        ...(riskRaised ? { riskRaised } : {}),
        ...(context.replan ? { replan: context.replan, ...(changed?.trim() ? { changed } : {}) } : {}),
        cases,
        // Coverage by criterion id: what each criterion's scenarios are, the score against the repo's bar, and what is still open.
        coverageReport: { score: report.score, bar: coverageBar, gaps: report.gaps, thin: report.thin, untestable: report.untestable, open: notes, per: report.per.map((p) => ({ id: p.criterion.id, text: p.criterion.text, scenarios: p.scenarios, types: p.types })) },
        risk,
        // Who may approve, from the repo's `plan.approvers` (the diagram's numbers when it says nothing) and the code map's owners, in the gate's words.
        approvalRule: approvalRule(level, repoPlan?.approvers ?? FACTORY_DEFAULTS.plan.approvers, map?.owners ?? []),
        verdicts,
        // The decisions' records, so the gate's outcome can be written onto them (decision-truth.ts).
        decisions: Object.fromEntries(([["coverage_check", coverage], ["plan_check", planCheck], ["risk_score", riskJudged]] as const).flatMap(([pack, judged]) => (judged.recordId ? [[pack, judged.recordId]] : []))),
        rounds: { tests: testRuns, plan: planRuns },
        flagged: [...flagged],
        map,
        ...(mapNote ? { mapNote } : {}),
        lane,
        ...(laneNote ? { laneNote } : {}),
      },
    };
  };
}
