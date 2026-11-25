// The dedicated review passes beside a PR review: a security, a migration, an infrastructure and a second-opinion
// reviewer, each its own pack and engine, run on every PR whatever the files. They read the same diff as the main
// reviewer. A pass that fails or answers badly is a note, never a failed review. What a pass found that the main
// reviewer did not is checked once more (`finding_confirm`) before it joins the review.
import { type DecisionOverrides, type EngineId, type Finding, type StageEfforts, type StageEngines, type ReviewContext, type Verdict, REVIEW_HELPER_PACKS, type ReviewHelperPack, ReviewHelperAnswer, mergeDuplicateFindings } from "@hardness/contracts";

import type { StageContext, StageResult } from "../ports.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";
import { addUsage } from "./usage.ts";

/** A workspace of a pass's own: a read-only clone made before its run and removed after, so passes never share a folder. */
export interface PassWorkspace {
  path: string;
  branch: string;
}

/** A host folder a pass reads read-only in its container (the big PR's diff, one file per changed file). */
export interface PassMount {
  host: string;
  container: string;
  readOnly: true;
}

export interface HelperDeps {
  /** Runs one pass's pack as a sub-run beside the stage's own pack, in the workspace made for it when `workspace` is given. */
  run: (context: StageContext, pack: ReviewHelperPack, review: ReviewContext, workspace?: PassWorkspace, mounts?: readonly PassMount[]) => Promise<StageResult>;
  /** Makes and removes each pass's own workspace. A pass whose workspace cannot be made becomes a note; the others go on. Absent, passes run without one (and must not run at once). */
  workspace?: { make: (context: StageContext, label: string) => Promise<PassWorkspace>; remove: (workspace: PassWorkspace) => void | Promise<void> };
  /** How many passes run at once: all four by default. */
  concurrency?: number;
  /** The repo's luna.yaml engines and efforts, so the risk read never suggests over them. */
  policy?: (repoPath: string | null) => Promise<{ engines?: StageEngines | null; effort?: StageEfforts | null }>;
  /** Whether this machine can run an engine now (its login is present); the risk read uses it for a second opinion on Codex. */
  engineReady?: (engine: EngineId, repoPath: string | null) => Promise<boolean>;
}

export interface HelperRun {
  pack: ReviewHelperPack;
  /** The engine the pass ran on, when its run said. */
  engine?: string;
  outcome: "ok" | "failed" | "unparseable";
  findings: Finding[];
  summary: string;
}

export interface HelpersOutcome {
  helpers: HelperRun[];
  notes: string[];
  /** What the passes cost together: absent when none reported any. */
  usage?: StageResult["usage"];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs every review pass on `review`; never throws. The passes come back in the order of `REVIEW_HELPER_PACKS`. */
export async function runHelpers(deps: HelperDeps, context: StageContext, review: ReviewContext, mounts?: readonly PassMount[], suggested?: Partial<Record<ReviewHelperPack, NonNullable<StageContext["suggested"]>>>): Promise<HelpersOutcome> {
  const limit = Math.max(1, deps.concurrency ?? REVIEW_HELPER_PACKS.length);
  const results: PromiseSettledResult<StageResult>[] = new Array(REVIEW_HELPER_PACKS.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < REVIEW_HELPER_PACKS.length; i = next++) {
      const pack = REVIEW_HELPER_PACKS[i]!;
      const sub: StageContext = { ...context, runId: `${context.runId}-${pack}`, started: undefined, resume: undefined, engine: undefined, suggested: suggested?.[pack] };
      let made: PassWorkspace | undefined;
      try {
        if (deps.workspace) made = await deps.workspace.make(sub, pack);
        results[i] = { status: "fulfilled", value: await deps.run(sub, pack, review, made, mounts) };
      } catch (error) {
        results[i] = { status: "rejected", reason: error };
      } finally {
        if (made) await Promise.resolve(deps.workspace!.remove(made)).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, REVIEW_HELPER_PACKS.length) }, worker));

  const notes: string[] = [];
  let usage: StageResult["usage"];
  const helpers = REVIEW_HELPER_PACKS.map((pack, i): HelperRun => {
    const settled = results[i]!;
    if (settled.status === "rejected") {
      notes.push(`${pack} did not run: ${messageOf(settled.reason)}`);
      return { pack, outcome: "failed", findings: [], summary: "" };
    }
    const result = settled.value;
    usage = addUsage(usage, result.usage);
    const engine = result.run?.info?.engine;
    if (result.outcome !== "pass") {
      notes.push(`${pack} ${result.outcome === "fail" ? "failed" : result.outcome}: the review went on without it`);
      return { pack, ...(engine ? { engine } : {}), outcome: "failed", findings: [], summary: "" };
    }
    const parsed = ReviewHelperAnswer.safeParse(result.detail?.answer);
    if (!parsed.success) {
      notes.push(`${pack}: its answer did not parse; the review went on without it`);
      return { pack, ...(engine ? { engine } : {}), outcome: "unparseable", findings: [], summary: "" };
    }
    return { pack, ...(engine ? { engine } : {}), outcome: "ok", findings: parsed.data.findings, summary: parsed.data.summary };
  });
  return { helpers, notes, ...(usage ? { usage } : {}) };
}

export interface ConfirmDeps {
  /** finding_confirm on a check context; null keeps every finding unchecked. Read at call time. */
  decide: Decide | null;
  repoPath: string | null;
  decisions: Record<string, DecisionOverrides>;
  /** The code around a finding, as the judge is shown it. */
  excerpt: (finding: Finding) => Promise<string>;
  log?: (line: string) => void;
}

export interface Confirmed {
  /** The helper findings that stay, each with whether the judge was unsure of it. */
  kept: Array<{ finding: Finding; unsure: boolean; pack: ReviewHelperPack }>;
  /** Helper findings the main reviewer also made: they merge into the main's, with no question asked. */
  agreed: Finding[];
  /** Per pass, how many of its checked findings landed on each verdict (proceed, flag, ask, skipped). */
  verdicts: Partial<Record<ReviewHelperPack, Record<string, number>>>;
  /** Per pass, how many findings the main reviewer had made too. */
  duplicates: Partial<Record<ReviewHelperPack, number>>;
  /** The main reviewer's own findings, each with whether the judge was unsure of it. A confident "not real" marks one unsure and never drops it. */
  main: Array<{ finding: Finding; unsure: boolean }>;
  /** How many of the main reviewer's findings landed on each verdict. */
  mainVerdicts: Record<string, number>;
}

/** A finding the main reviewer made too: adding it to the main's findings folds into one of them. */
const madeToo = (main: readonly Finding[], f: Finding): boolean => mergeDuplicateFindings([...main, f]).length === mergeDuplicateFindings(main).length;

/** Checks the findings once more against the code: the helpers' own (what the main reviewer did not make too) and the main reviewer's. For a helper's: proceed on a yes keeps it, proceed on a no drops it, flag keeps it marked unsure, ask drops it, and a check that did not run keeps it. */
export async function confirmHelperFindings(deps: ConfirmDeps, helpers: readonly Pick<HelperRun, "pack" | "findings">[], main: readonly Finding[]): Promise<Confirmed> {
  const out: Confirmed = { kept: [], agreed: [], verdicts: {}, duplicates: {}, main: [], mainVerdicts: {} };
  const asked: Array<{ pack: ReviewHelperPack; finding: Finding }> = [];
  for (const helper of helpers) {
    for (const finding of helper.findings) {
      if (madeToo(main, finding)) {
        out.agreed.push(finding);
        out.duplicates[helper.pack] = (out.duplicates[helper.pack] ?? 0) + 1;
      } else asked.push({ pack: helper.pack, finding });
    }
  }
  const judge = async (finding: Finding): Promise<{ verdict: Verdict | "skipped"; real: unknown }> => {
    const excerpt = await deps.excerpt(finding).catch(() => "");
    const { verdict, answer } = await judgeCheck(deps.decide, "finding_confirm", { kind: "finding", finding, excerpt }, deps.repoPath, deps.decisions, deps.log);
    return { verdict, real: (answer?.real as { value?: unknown } | undefined)?.value };
  };
  const [judged, judgedMain] = await Promise.all([
    Promise.all(
      asked.map(async ({ pack, finding }) => {
        const { verdict, real } = await judge(finding);
        // A confident no is a "proceed" on the question's own terms: the finding is not real.
        const keep = verdict === "skipped" || verdict === "flag" || (verdict === "proceed" && real !== false);
        return { pack, finding, verdict, keep, unsure: verdict === "flag" };
      }),
    ),
    // The main reviewer's findings are asked too, but never dropped: a "not real" or an unsure answer only marks them.
    Promise.all(
      main.map(async (finding) => {
        const { verdict, real } = await judge(finding);
        return { finding, verdict, unsure: verdict === "flag" || (verdict === "proceed" && real === false) };
      }),
    ),
  ]);
  for (const j of judgedMain) {
    out.mainVerdicts[j.verdict] = (out.mainVerdicts[j.verdict] ?? 0) + 1;
    out.main.push({ finding: j.finding, unsure: j.unsure });
  }
  for (const j of judged) {
    const counts = (out.verdicts[j.pack] ??= {});
    counts[j.verdict] = (counts[j.verdict] ?? 0) + 1;
    if (j.keep) out.kept.push({ finding: j.finding, unsure: j.unsure, pack: j.pack });
  }
  return out;
}
