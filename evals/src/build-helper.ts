// The build-helper eval (RFC 0013, phase 5): `implementing` on a card with one logic slice and one UI slice, with the ui-designer helper on and with delegation off.
// This file is the part with no model in it: the cases, and the report shaped from what a run left (the machine's own `build.helper_*` rows, the files on the card's branch,
// the run's outcome and wall clock). `build-helper-run.ts` drives the real runs; the cli prints what this file shapes. Local only, never in CI.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DesignSpec, StageInput } from "@hardness/contracts";
import { z } from "zod";

const Slice = z.object({ title: z.string().min(1), touchpoints: z.array(z.string().min(1)).min(1), acceptance: z.array(z.string().min(1)).min(1) });

/** A card: its logic slice, and the `ui_design` case whose slice and design spec are its UI half. */
export const BuildCase = z.object({ schema: z.literal(1), id: z.string().min(1), uiCase: z.string().min(1), title: z.string().min(1), description: z.string().min(1), logic: Slice });
export type BuildCase = z.infer<typeof BuildCase>;

export interface LoadedBuildCase extends BuildCase {
  /** The card's two slices in plan order: the logic slice, then the UI slice. */
  slices: Array<{ title: string; est_loc: number; touchpoints: string[]; acceptance: string[] }>;
  spec: DesignSpec;
  /** The replayed design servers (the ui_design case's mcp folder) and the fixture repo. */
  mcpDir: string;
  repoPath: string;
  fileKey: string;
  nodeId: string;
  /** The scenario test files of the UI slice: locked for both builders. */
  testsFiles: string[];
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Every build-helper case (or the ones named), each joined to its ui_design case; a bad case throws with its path. */
export function loadBuildCases(evalsDir: string, only: string[] = []): LoadedBuildCase[] {
  const dir = join(evalsDir, "build_helper");
  const ids = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new Error(`no build-helper case named ${missing.join(", ")} (have: ${ids.join(", ") || "none"})`);
  return ids
    .filter((id) => only.length === 0 || only.includes(id))
    .map((id) => {
      const file = join(dir, `${id}.json`);
      const parsed = BuildCase.safeParse(readJson(file));
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const ui = join(evalsDir, "ui_design", "cases", parsed.data.uiCase);
      const stage = StageInput.safeParse(readJson(join(ui, "stage.json")));
      if (!stage.success) throw new Error(`${ui}/stage.json: ${stage.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const spec = stage.data.context.plan?.designSpec;
      const slice = stage.data.context.helper?.slice;
      const ref = stage.data.context.design?.refs[0];
      if (!spec || !slice || !ref) throw new Error(`${ui}/stage.json: not a ui_design case with a spec, a slice and a design reference`);
      if (parsed.data.id !== id) throw new Error(`${file}: the id is ${parsed.data.id}`);
      const clash = parsed.data.logic.touchpoints.filter((f) => slice.touchpoints.includes(f));
      if (clash.length > 0) throw new Error(`${file}: the logic and the UI slice both touch ${clash.join(", ")}`);
      return {
        ...parsed.data,
        slices: [
          { title: parsed.data.logic.title, est_loc: 30, touchpoints: parsed.data.logic.touchpoints, acceptance: parsed.data.logic.acceptance },
          { title: slice.title, est_loc: 60, touchpoints: slice.touchpoints, acceptance: slice.acceptance },
        ],
        spec,
        mcpDir: join(ui, "mcp"),
        repoPath: stage.data.task.repoPath,
        fileKey: ref.fileKey,
        nodeId: ref.nodeIds[0] ?? "",
        testsFiles: (stage.data.context.scenarioTests ?? []).map((t) => t.file),
      };
    });
}

/** What one run of `implementing` left. `delegation` says which kind of run it was. */
export interface BuildTrial {
  delegation: "on" | "off";
  outcome: string;
  /** The escalation reason, when the run escalated. */
  escalation?: string;
  wallMs: number;
  /** Every file the card's branch changed since the tests commit. */
  changed: string[];
  /** The machine's own `build.helper_*` rows. */
  rows: Array<{ kind: string; payload: Record<string, unknown> }>;
}

/** A file is planned when a slice names it, exactly or as a folder (the machine's own scope rule is stricter and has already run; this is the report's reading). */
const planned = (file: string, touchpoints: string[]): boolean => touchpoints.some((t) => file === t || (t.endsWith("/") && file.startsWith(t)));

export interface TrialReport {
  delegation: "on" | "off";
  outcome: string;
  wallMs: number;
  /** Each slice's planned files changed on the branch: the slice is committed. */
  committed: { logic: boolean; ui: boolean };
  /** Every changed file is a planned file or a scenario test. */
  scopeClean: boolean;
  /** Files changed outside the plan. */
  strays: string[];
  /** Helper slices the machine picked, and conflicts it met (`build.helper_conflict` rows). */
  picks: number;
  conflicts: number;
  /** The helper ran at all (a `build.helper_started` row). */
  delegated: boolean;
  /** The engine the helper ran on, from the `build.helper_started` row; null when no helper started or the row names none. */
  helperEngine: string | null;
  escalation: string | null;
}

export function trialReport(c: LoadedBuildCase, trial: BuildTrial): TrialReport {
  const [logic, ui] = c.slices as [LoadedBuildCase["slices"][number], LoadedBuildCase["slices"][number]];
  const done = (touchpoints: string[]) => touchpoints.some((t) => trial.changed.includes(t));
  const all = [...logic.touchpoints, ...ui.touchpoints];
  const strays = trial.changed.filter((f) => !planned(f, all) && !c.testsFiles.includes(f));
  const count = (kind: string) => trial.rows.filter((r) => r.kind === kind).length;
  return {
    delegation: trial.delegation,
    outcome: trial.outcome,
    wallMs: trial.wallMs,
    // The UI slice's own files: its scenario test is a locked file the card's tests commit already holds, so the slice is the planned source file.
    committed: { logic: done(logic.touchpoints.filter((f) => !f.startsWith("test/"))), ui: done(ui.touchpoints) },
    scopeClean: strays.length === 0,
    strays,
    picks: count("build.helper_picked"),
    conflicts: count("build.helper_conflict"),
    delegated: count("build.helper_started") > 0,
    helperEngine: (trial.rows.find((r) => r.kind === "build.helper_started")?.payload.engine as string | undefined) ?? null,
    escalation: trial.escalation ?? null,
  };
}

export interface CaseReport {
  id: string;
  delegated: TrialReport;
  baseline: TrialReport | null;
  /** Both slices committed, scope clean, the helper ran and its picks met no conflict. */
  pass: boolean;
  /** Delegated wall clock over the baseline's; null without a baseline run. */
  ratio: number | null;
  problems: string[];
}

/** One case's verdict from its delegated run and, when there was one, the run with delegation off. */
export function caseReport(c: LoadedBuildCase, delegated: BuildTrial, baseline: BuildTrial | null): CaseReport {
  const on = trialReport(c, delegated);
  const off = baseline ? trialReport(c, baseline) : null;
  const problems: string[] = [];
  if (on.outcome !== "pass") problems.push(`the run ended ${on.outcome}${on.escalation ? ` (${on.escalation})` : ""}`);
  if (!on.committed.logic) problems.push("the logic slice is not on the branch");
  if (!on.committed.ui) problems.push("the UI slice is not on the branch");
  if (!on.scopeClean) problems.push(`files outside the plan: ${on.strays.join(", ")}`);
  if (!on.delegated) problems.push("the implementer never delegated the UI slice");
  else if (on.picks === 0) problems.push("the helper ran but nothing was picked");
  if (on.conflicts > 0) problems.push(`${on.conflicts} pick conflict${on.conflicts === 1 ? "" : "s"}`);
  if (off && off.delegated) problems.push("the baseline run delegated: delegation was not off");
  return { id: c.id, delegated: on, baseline: off, pass: problems.length === 0, ratio: off && off.wallMs > 0 ? Math.round((on.wallMs / off.wallMs) * 100) / 100 : null, problems };
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
const yes = (v: boolean): string => (v ? "yes" : "NO");

/** The printed report: one block per case and a closing line. */
export function renderReport(engine: string, reports: CaseReport[]): string {
  const lines = [`build-helper on ${engine}`];
  for (const r of reports) {
    const d = r.delegated;
    lines.push(
      `${r.pass ? "PASS" : "FAIL"} ${r.id}`,
      `  both slices committed: ${yes(d.committed.logic && d.committed.ui)} (logic ${yes(d.committed.logic)}, ui ${yes(d.committed.ui)})`,
      `  scope clean: ${yes(d.scopeClean)}${d.strays.length ? ` (${d.strays.join(", ")})` : ""}`,
      `  picks: ${d.picks}, conflicts: ${d.conflicts}${d.delegated ? "" : " (no helper ran)"}`,
      ...(d.helperEngine ? [`  helper engine: ${d.helperEngine}`] : []),
      `  wall clock: ${minutes(d.wallMs)} with the helper${r.baseline ? `, ${minutes(r.baseline.wallMs)} with delegation off${r.ratio !== null ? ` (${r.ratio}x)` : ""}` : ", no run with delegation off"}`,
    );
    for (const p of r.problems) lines.push(`  problem: ${p}`);
  }
  const passed = reports.filter((r) => r.pass).length;
  lines.push(`${passed}/${reports.length} cases passed`);
  return lines.join("\n");
}

/** The cases and what each would run, with no model: for `--dry`. */
export function renderDry(cases: LoadedBuildCase[], baseline: boolean): string {
  return [
    `${cases.length} build-helper cases (${baseline ? "each with the helper on and with delegation off" : "each with the helper on"}); nothing runs`,
    ...cases.map((c) => `  ${c.id}: ${c.slices.map((s) => `"${s.title}" [${s.touchpoints.join(", ")}]`).join(" + ")} · design ${c.fileKey} ${c.nodeId} · replay ${c.uiCase}`),
  ].join("\n");
}

/** Runs `run` with Ctrl-C wired to `abort` (the run stops its containers on the signal), and takes the handler off afterwards, whatever `run` does. */
export async function untilInterrupted<T>(abort: AbortController, run: () => Promise<T>): Promise<T> {
  const onSigint = () => abort.abort();
  process.once("SIGINT", onSigint);
  try {
    return await run();
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
