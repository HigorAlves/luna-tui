// The e2e stage: skip repos with no web surface and changes that touch none of it; otherwise
// run the e2e pack in the QA image and turn its verdict into a pass or a fail for the e2e loop.
import { touchesRenderedSurface } from "../../domain/rendered.ts";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { branchBase, diffNameStatus, headCommit } from "../../adapters/git/worktree.ts";
import { A11yAuditAnswer, type CapturePlan, type DecisionOverrides, type Finding, type VerifyDesignReport, mergeDuplicateFindings, severityOf } from "@hardness/contracts";

import type { Policy } from "../../domain/policy.ts";
import { trustOf } from "../../domain/trust.ts";
import { a11yFindings } from "../../domain/a11y-findings.ts";
import type { DesignBudget } from "../../domain/design-budget.ts";
import { designSteps } from "../../domain/verify-order.ts";
import { type ManifestRow, boundedArtifacts, manifestRows } from "../../domain/e2e-manifest.ts";
import { blockerSetKey } from "../../domain/finding-sets.ts";
import { type Unplaced } from "../../domain/design-parity.ts";
import { capturePlan, citedWithoutViewport } from "../../domain/parity-plan.ts";
import { approvedScenarios, designSpecOf } from "../../domain/stage-input.ts";
import { type ScenarioRow, scenarioFindings } from "../../domain/send-back.ts";
import { type OpenAppInput, type OpenAppResult, type OpenPreviewResult, e2eModeOf } from "../app-session.ts";
import { blockedPayloads } from "../egress-policy.ts";
import { type Collected, collectCaptures } from "../parity-captures.ts";
import type { AgentExtra } from "./pack-runner.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type TruthSink, e2eCauseTruth } from "../decision-truth.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";
import { classifyFindings } from "./classify-findings.ts";
import type { DesignParityOutcome } from "./design-parity.ts";
import { designBudgetEscalation, designRun } from "./design-run.ts";
import { addUsage } from "./usage.ts";
import { verdictOf } from "./verify.ts";

type BrowserExtra = Pick<AgentExtra, "qaTarget" | "alsoJoin" | "noProxy" | "redactValues">;

/** What the browser run captured for the frames its scenarios cite: the plan it followed, what the machine took in, and the folder it keeps them in. */
export type ParityRun = { plan: CapturePlan; dir: string } & Collected;

/** What a step after a passing browser run is handed: the run's own context, the extra the browser run had (so the same target, network and redaction), and how the browser run ended. */
export interface AfterBrowserInput {
  context: StageContext;
  extra: BrowserExtra | undefined;
  browserRun: "pass" | "skipped";
  /** The captures the browser run took (RFC 0013, phase 3); null when none were planned. */
  parity?: ParityRun | null;
  /** What the steps before this one left, in order (the parity step reads the accessibility audit's findings). */
  previous?: AfterBrowserOutput[];
}

/** What such a step leaves: its detail under `key`, findings for Build, whether they block, its usage, or an escalation that ends the stage. A step that has nothing to say returns null. */
export interface AfterBrowserOutput {
  key: string;
  detail?: unknown;
  findings?: Finding[];
  blocking?: boolean;
  usage?: StageResult["usage"];
  escalate?: StageResult;
  /** More detail keys the step leaves beside its own (the parity step's `design` report). */
  also?: Record<string, unknown>;
}

/** One step run after the browser run while its app or preview is still open (RFC 0013: the accessibility audit; phase 3 adds design parity). Its failure never changes the browser run's verdict. */
export type AfterBrowserStep = (input: AfterBrowserInput) => Promise<AfterBrowserOutput | null>;

export interface E2eDeps {
  /** Runs the e2e pack; `extra` names the one target the machine chose (the app it started), the network to join and the names to reach directly. */
  runPack: (context: StageContext, extra?: BrowserExtra & Partial<Pick<AgentExtra, "a11yLevel" | "parityPlan">>, pack?: "e2e" | "a11y_audit") => Promise<StageResult>;
  /** The designer agents (RFC 0013): the repo's settings, whether a person turned design off for the card, and the design budget. Absent, no audit runs. */
  design?: {
    settings: (repoPath: string | null, taskId: string) => Promise<{ off: boolean; cardOff: boolean; level: "AA" | "AAA"; mode: "gate" | "advisory" }>;
    budget?: (taskId: string) => Promise<DesignBudget>;
  };
  /**
   * The design parity review (RFC 0013, phase 3), run after the audit when the browser run took captures: the captures the plan asked for and the cited frames with
   * no viewport. Null when it has nothing to review; an `escalate` ends the stage (the budget is spent). Absent, no review runs.
   */
  designParity?: (context: StageContext, parity: ParityRun, unplaced: Unplaced[]) => Promise<DesignParityOutcome | { escalate: StageResult } | null>;
  /** Further steps after the accessibility audit, in order, in the same open app session. */
  afterBrowser?: AfterBrowserStep[];
  /** Starts and seeds the repository's app (`verify.e2e.start`); absent, the browser run boots its own server as before. */
  openApp?: (input: OpenAppInput) => Promise<OpenAppResult>;
  /** Waits for the preview the repository's `url_pattern` names (`verify.e2e.deploy`), deploying first when it has a command. */
  openPreview?: (input: OpenAppInput & { branch: string }) => Promise<OpenPreviewResult>;
  /** The card's head commit, for the install; defaults to the real one. */
  headCommit?: (worktreePath: string) => Promise<string>;
  detectWeb?: (worktreePath: string) => Promise<boolean>;
  /** The web package dirs, relative ("" is the root); their src/ counts as rendered surface. */
  webRoots?: (worktreePath: string) => Promise<string[]>;
  /** Paths the task branch changed; null when the base is unknown (then the pack runs). */
  changedFiles?: (worktreePath: string, repoPath: string | null) => Promise<string[] | null>;
  /** The repo's config: `qa: none` means this repo never gets a browser run. */
  policy?: (repoPath: string | null) => Promise<Pick<Policy, "qa"> & { qaTargets?: Policy["qaTargets"]; factory?: { verify: { env_flake_retries: number } & Partial<Pick<Policy["factory"]["verify"], "e2e">> } }>;
  /** Runs e2e_failure_cause on a failed run; null (or absent) leaves a failure as it is. Read at call time. */
  decide?: Decide | null;
  /** The repo's per-pack decision bars. */
  overrides?: (repoPath: string | null) => Promise<Record<string, DecisionOverrides>>;
  /** Told when the re-run settles whether an `env_flake` was one (RFC 0005 wave 7). */
  truth?: TruthSink | null;
  /** The machine's state dir: a re-run starts from an empty `runs/<runId>/out`, so the first attempt's packet never reaches Evidence. */
  stateDir?: string;
}

const RANK: Record<"blocker" | "should_fix" | "nit", number> = { blocker: 0, should_fix: 1, nit: 2 };
/** The design report keeps this many findings. */
const DESIGN_FINDINGS_MAX = 40;
const EXCERPT_CAP = 2000;

/** What finding_classify is shown of a design finding: where it is in the frame and the build, and what differs. */
function designExcerpt(f: Finding): string {
  const d = f.design;
  if (!d) return "";
  const text = d.source === "parity" ? `frame ${d.frame ?? ""} node ${d.node ?? ""}\nelement: ${d.element}\nexpected: ${d.expected ?? ""}\nbuilt: ${d.actual ?? ""}` : `element: ${d.element}\n${f.body}`;
  return text.slice(0, EXCERPT_CAP);
}

/** How many failed scenarios the cause decision is asked about. */
const CAUSE_MAX = 5;
type Cause = "product_bug" | "test_bug" | "env_flake";

const WEB_SCRIPTS = ["dev", "start", "preview"];
const WEB_FRAMEWORKS = ["next", "vite", "react", "vue", "svelte", "astro", "nuxt", "remix"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor"]);
/** Where a monorepo keeps its apps: one level of these is scanned for a web package.json. */
const WORKSPACE_DIRS = ["apps", "packages", "services", "sites"];

const isFile = (path: string) => stat(path).then((s) => s.isFile(), () => false);

async function webPackage(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    if (WEB_SCRIPTS.some((name) => typeof scripts[name] === "string")) return true;
    const deps = { ...((pkg.dependencies ?? {}) as object), ...((pkg.devDependencies ?? {}) as object) };
    return WEB_FRAMEWORKS.some((name) => name in deps);
  } catch {
    return false; // no package.json, or not JSON
  }
}

/** The dirs a browser can open, relative to the worktree: "" when the repo itself is a web
 *  package (or carries an index.html), plus each workspace app that is. */
export async function webRoots(worktreePath: string): Promise<string[]> {
  const roots: string[] = [];
  if ((await webPackage(worktreePath)) || (await isFile(join(worktreePath, "index.html")))) {
    roots.push("");
  }
  try {
    for (const entry of await readdir(worktreePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const dir = join(worktreePath, entry.name);
      if ((await isFile(join(dir, "index.html"))) && roots.length === 0) roots.push("");
      if (!WORKSPACE_DIRS.includes(entry.name)) continue;
      for (const pkg of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (pkg.isDirectory() && (await webPackage(join(dir, pkg.name)))) roots.push(`${entry.name}/${pkg.name}`);
      }
    }
  } catch {
    // unreadable worktree: no web surface
  }
  return roots;
}

/** True when the worktree looks like something a browser can open. */
export async function detectWeb(worktreePath: string): Promise<boolean> {
  return (await webRoots(worktreePath)).length > 0;
}

export { touchesRenderedSurface };

/** What the task branch changed since it forked, from git; null when that is unknown. */
export async function changedFilesSinceBase(worktreePath: string, repoPath: string | null): Promise<string[] | null> {
  if (!repoPath) return null;
  const base = await branchBase(worktreePath, repoPath);
  if (!base) return null;
  return (await diffNameStatus(worktreePath, base, "HEAD"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1)!);
}

export function e2eRunner(deps: E2eDeps): StageRunner {
  const detect = deps.detectWeb ?? detectWeb;
  const changed = deps.changedFiles ?? changedFilesSinceBase;
  const roots = deps.webRoots ?? webRoots;
  return async (context) => {
    const worktree = context.task.worktreePath;
    const repoPolicy = deps.policy ? await deps.policy(context.task.repoPath ?? null) : null;
    // The repo's luna.yaml `verify.env_flake_retries`; the diagram's default is the one re-run this stage always made.
    const flakeRetries = repoPolicy?.factory?.verify.env_flake_retries ?? 1;
    if (repoPolicy?.qa === "none") {
      return { outcome: "pass", detail: { step: "e2e", skipped: true, reason: "the repo's config says qa: none" } };
    }
    if (!worktree || !(await detect(worktree))) {
      return { outcome: "pass", detail: { step: "e2e", skipped: true, reason: "no web surface detected" } };
    }
    // A browser can only show what the change touched: a pure library or docs change on a
    // web repo has nothing to drive, and used to cost a QA run per attempt.
    const files = await changed(worktree, context.task.repoPath ?? null);
    if (files !== null && !touchesRenderedSurface(files, await roots(worktree))) {
      return { outcome: "pass", detail: { step: "e2e", skipped: true, reason: "the change touches no rendered surface", files } };
    }
    const settle = ([pack, preview, note]: [StageResult, { kind: string; url: string } | null, string | null]): StageResult => {
      const extra = { ...(preview ? { preview } : {}), ...(note ? { note } : {}) };
      if (pack.outcome !== "pass") return { ...pack, detail: { ...pack.detail, step: "e2e", ...extra } };
      const answer = (pack.detail?.answer ?? {}) as Record<string, unknown>;
      const verdict = typeof answer.verdict === "string" ? answer.verdict : undefined;
      // `skipped` is not a result.json outcome; the runner reports it as a pass, and so do we.
      const passed = verdict === "pass" || verdict === "skipped";
      const summary = typeof answer.summary === "string" ? answer.summary : String(pack.detail?.summary ?? "");
      return {
        ...pack,
        outcome: passed ? "pass" : "fail",
        detail: {
          step: "e2e",
          verdict: verdict ?? "none",
          summary,
          criteria: Array.isArray(answer.criteria) ? answer.criteria : [],
          ...extra,
          ...(verdict === "skipped" ? { skipped: true, note: `e2e skipped by the QA agent: ${summary}` } : {}),
          ...(verdict ? {} : { error: "the e2e pack gave no verdict" }),
        },
      };
    };
    // The browser run grades the browser scenarios only (layer e2e; a plan with no layers keeps them all): a unit, diff or build scenario is not
    // something a browser can see, and grading it made every run partial. Verify judges those.
    const approved = approvedScenarios(context.approvals);
    const layered = approved.some((sc) => sc.layer);
    const scenarios = approved.filter((sc) => !layered || sc.layer === "e2e").map((sc) => ({ id: sc.id ?? "", title: sc.title, criterion_ref: sc.criterion_ref ?? null }));
    const qaDir = deps.stateDir ? join(deps.stateDir, "runs", context.runId, "files", "qa") : null;
    /** The manifest the machine checks by script: one row per approved scenario, artifacts only when they are plain-named regular files in the run's folder; a scenario that is not a pass (not run, failed or partial) fails a passing verdict. */
    const judged = async (r: StageResult): Promise<StageResult> => {
      const d = r.detail as { criteria?: unknown[]; summary?: unknown; verdict?: string; skipped?: boolean } | undefined;
      if (scenarios.length === 0 || d?.skipped === true || (r.outcome !== "pass" && r.outcome !== "fail")) return r;
      const rows = manifestRows(scenarios, d?.criteria ?? [], typeof d?.summary === "string" ? d.summary : "");
      for (const row of rows) row.artifacts = await boundedArtifacts(row.artifacts, qaDir);
      const incomplete = rows.some((row) => row.result !== "pass");
      return incomplete && r.outcome === "pass"
        ? { ...r, outcome: "fail", detail: { ...r.detail, verdict: "partial", manifest: rows } }
        : { ...r, detail: { ...r.detail, manifest: rows } };
    };
    const manifestOf = (r: StageResult): ManifestRow[] | null => ((r.detail as { manifest?: ManifestRow[] } | undefined)?.manifest) ?? null;
    /** The scenarios that did not pass, from the manifest when there is one, else from the run's own rows. */
    const failedRows = (r: StageResult): ScenarioRow[] => {
      const manifest = manifestOf(r);
      if (manifest) {
        return manifest
          .filter((row) => row.result !== "pass")
          .map((row) => ({ text: row.title, criterion: row.criterion, result: row.result === "not_run" ? "fail" : row.result, evidence: row.artifacts, seen: row.result === "not_run" ? "the scenario was not run" : row.seen }));
      }
      const d = r.detail as { criteria?: unknown[] } | undefined;
      return (d?.criteria ?? []).flatMap((c): ScenarioRow[] => {
        const row = c as { text?: unknown; criterion?: unknown; result?: unknown; evidence?: unknown } | null;
        return row && typeof row === "object" && typeof row.text === "string" && typeof row.result === "string"
          ? [{ text: row.text, criterion: typeof row.criterion === "string" ? row.criterion : null, result: row.result, evidence: Array.isArray(row.evidence) ? row.evidence.filter((e): e is string => typeof e === "string") : [] }]
          : [];
      });
    };
    /** One browser run: in `start` mode a fresh app first (each attempt, the re-run too), that one target on its network, and the app closed after, whatever happens. */
    let runs = 0;
    type Attempted = { done: StageResult } | { settled: StageResult; after: AfterBrowserOutput[] };
    /** The accessibility audit (RFC 0013): on the same target, at the repo's level, with the design budget read before and after. Its failure never changes the browser run's verdict. */
    const e2eConfig = repoPolicy?.factory?.verify.e2e;
    const e2eMode = repoPolicy && e2eConfig ? e2eModeOf({ qaTargets: repoPolicy.qaTargets ?? [], factory: { verify: { e2e: e2eConfig } } as never }) : "agent";
    // Parity (RFC 0013, phase 3): with an approved spec and design on, the browser run is asked for the frames its scenarios cite. Like the audit, it needs an app URL.
    const parityDesign = deps.design && qaDir ? await deps.design.settings(context.task.repoPath ?? null, context.task.id) : null;
    const spec = parityDesign && !parityDesign.off && !parityDesign.cardOff ? designSpecOf(context.approvals) : null;
    const parityPlan = spec && e2eMode !== "agent" ? capturePlan(approved, spec) : null;
    const parityDir = deps.stateDir ? join(deps.stateDir, "runs", context.runId, "parity") : null;
    /** The extra the browser run is given: the plan rides along only when there is one, so a run without a design reference is called as it always was. */
    const planned = (extra: BrowserExtra): BrowserExtra & { parityPlan?: CapturePlan } => (parityPlan ? { ...extra, parityPlan } : extra);
    /** A re-run starts from nothing: what the first attempt left in the run's folders is not its packet. */
    const clearRun = async () => {
      if (!deps.stateDir) return;
      await rm(join(deps.stateDir, "runs", context.runId, "out"), { recursive: true, force: true });
      if (parityDir) await rm(parityDir, { recursive: true, force: true });
      if (qaDir) await rm(join(qaDir, "parity"), { recursive: true, force: true });
    };
    const auditStep: AfterBrowserStep = async ({ extra, browserRun }) => {
      const settings = deps.design ? await deps.design.settings(context.task.repoPath ?? null, context.task.id) : null;
      if (!settings) return null;
      const steps = designSteps({ off: settings.off, cardOff: settings.cardOff, qa: repoPolicy?.qa ?? "web", touchesRendered: true, hasDesignRef: false, browserRun });
      if (!steps.includes("a11y_audit")) return null;
      // Agent mode (no `verify.e2e.start`, no deploy): the browser run boots its own server, so there is no app URL to audit.
      if (e2eMode === "agent") return { key: "a11y", detail: { skipped: "no app URL in agent mode" } };
      const { result, spentAfter } = await designRun(
        { ...(deps.design?.budget ? { budget: deps.design.budget } : {}) },
        context,
        "a11y_audit",
        () => deps.runPack({ ...context, runId: `${context.runId}-a11y`, started: undefined, resume: undefined, engine: undefined } as StageContext, { ...extra, a11yLevel: settings.level }, "a11y_audit"),
      );
      if (result.outcome === "escalated" && result.detail?.escalation === "design_budget") return { key: "a11y", escalate: { ...result, detail: { ...result.detail, step: "e2e" } } };
      const parsed = A11yAuditAnswer.safeParse(result.detail?.answer);
      if (result.outcome !== "pass" || !parsed.success) {
        const why = result.outcome !== "pass" ? String(result.detail?.reason ?? result.detail?.error ?? result.outcome) : "its answer did not parse";
        return { key: "a11y", detail: { level: settings.level, mode: settings.mode, findings: [], pages: [], notes: [`the accessibility audit did not run: ${why}`] }, usage: result.usage };
      }
      const mapped = a11yFindings(parsed.data.findings, settings);
      // Two rules or two states on one criterion, selector and page are one problem for Build: they merge, at the higher severity.
      const findings = mergeDuplicateFindings(mapped.findings);
      const blocking = verdictOf(findings) === "fail";
      // Build's own rule: blockers with the budget spent after the run go to a person, not back to Build.
      if (blocking && spentAfter && deps.design?.budget) return { key: "a11y", escalate: { ...designBudgetEscalation(await deps.design.budget(context.task.id)), usage: result.usage } };
      return { key: "a11y", detail: { level: settings.level, mode: settings.mode, findings, pages: parsed.data.pages, notes: mapped.notes }, findings, blocking, usage: result.usage };
    };
    /** The design parity review after the audit: its findings are classified with the audit's and joined in the design report; confident blockers fail the run. */
    const parityStep: AfterBrowserStep = async ({ parity, previous }) => {
      if (!parity || !deps.designParity) return null;
      const out = await deps.designParity(context, parity, citedWithoutViewport(approved, spec));
      if (!out) return null;
      if ("escalate" in out) return { key: "parity", escalate: out.escalate };
      const audit = (previous ?? []).find((o) => o.key === "a11y")?.detail as { level?: "A" | "AA" | "AAA"; mode?: "gate" | "advisory"; findings?: Finding[] } | undefined;
      const auditFindings = Array.isArray(audit?.findings) ? audit.findings : [];
      const merged = mergeDuplicateFindings([...out.findings, ...auditFindings])
        .map((f, i) => ({ f, i }))
        .sort((a, b) => RANK[severityOf(a.f.severity)] - RANK[severityOf(b.f.severity)] || a.i - b.i)
        .map(({ f }) => f)
        .slice(0, DESIGN_FINDINGS_MAX);
      const repoPath = context.task.repoPath ?? null;
      const { classified } = await classifyFindings({ decide: deps.decide ?? null, repoPath, decisions: (await deps.overrides?.(repoPath)) ?? {}, excerpt: async (f) => designExcerpt(f) }, merged);
      const counts = { blocker: 0, should_fix: 0, nit: 0, waived: 0 };
      for (const f of auditFindings) counts[severityOf(f.severity)]++;
      const design: VerifyDesignReport = {
        wcag: audit?.level ?? null,
        a11y: audit?.mode ? { mode: audit.mode, counts } : null,
        parity: out.report,
        findings: merged,
        ...(classified.length > 0 ? { classified: classified.map(({ id, recordId }) => ({ id, ...(recordId ? { recordId } : {}) })) } : {}),
        gate: out.gate,
      };
      const blocking = blockerSetKey(out.findings) !== null;
      // Build's own rule, as for the audit: blockers with the budget spent after the run go to a person, not back to Build.
      if (blocking && out.spentAfter && deps.design?.budget) return { key: "parity", escalate: { ...designBudgetEscalation(await deps.design.budget(context.task.id)), usage: out.usage } };
      return {
        key: "parity",
        // The browser run's own detail.parity (the plan, the captures, what is missing) stays; the review's settle joins it.
        detail: { ...parity, ...out.report, notes: [...parity.notes, ...out.notes] },
        also: { design },
        findings: out.findings,
        blocking,
        usage: out.usage,
      };
    };
    const afterSteps: AfterBrowserStep[] = [auditStep, parityStep, ...(deps.afterBrowser ?? [])];
    /** Settles the browser run, then, only when it passed, runs the steps after it (in order, stopping at an escalation) before the caller closes the app. */
    const finish = async (pack: StageResult, preview: { kind: string; url: string } | null, note: string | null, extra: BrowserExtra | undefined): Promise<Attempted> => {
      const settled = await judged(settle([pack, preview, note]));
      const verdict = (settled.detail as { verdict?: string; skipped?: boolean } | undefined);
      const after: AfterBrowserOutput[] = [];
      if (settled.outcome === "pass") {
        const browserRun = verdict?.skipped === true ? "skipped" : "pass";
        let parity: ParityRun | null = null;
        if (parityPlan && qaDir && parityDir) {
          parity = { plan: parityPlan, ...(await collectCaptures(qaDir, parityPlan, parityDir)), dir: parityDir };
          settled.detail = { ...settled.detail, parity };
        } else if (spec && e2eMode === "agent") settled.detail = { ...settled.detail, parity: { skipped: "no app URL in agent mode" } };
        for (const step of afterSteps) {
          const out = await step({ context, extra, browserRun, parity, previous: after });
          if (!out) continue;
          after.push(out);
          if (out.escalate) break;
        }
      }
      return { settled, after };
    };
    const attempt = async (): Promise<Attempted> => {
      const mode = e2eMode;
      const repoPath = context.task.repoPath ?? null;
      if (mode === "deploy" && deps.openPreview && repoPath) {
        const preview = await deps.openPreview({
          taskId: context.task.id,
          repoPath,
          workspace: worktree,
          commit: await (deps.headCommit ?? headCommit)(worktree),
          branch: context.task.branch ?? "",
          attempt: context.attempt * 10 + runs++,
          trust: trustOf(context.task),
          signal: context.signal,
          onBlocked: (step, rows) => void Promise.all(blockedPayloads(rows, step).map((payload) => context.emit?.("sandbox.egress_blocked", payload))).catch(() => {}),
        });
        if (!preview.ok) return { done: { outcome: "escalated", detail: preview.detail } };
        try {
          const extra = { qaTarget: { ...preview.target, credential: null }, redactValues: preview.redactValues };
          const pack = await deps.runPack(context, planned(extra));
          return await finish(pack, { kind: "deploy", url: preview.target.baseUrl }, null, extra);
        } finally {
          await preview.close();
        }
      }
      if (mode === "start" && deps.openApp && repoPath) {
        const opened = await deps.openApp({
          taskId: context.task.id,
          repoPath,
          workspace: worktree,
          commit: await (deps.headCommit ?? headCommit)(worktree),
          attempt: context.attempt * 10 + runs++,
          trust: trustOf(context.task),
          signal: context.signal,
          onBlocked: (step, rows) => void Promise.all(blockedPayloads(rows, step).map((payload) => context.emit?.("sandbox.egress_blocked", payload))).catch(() => {}),
        });
        if (!opened.ok) return { done: { outcome: "escalated", detail: opened.detail } };
        try {
          const extra = { qaTarget: { ...opened.target, credential: null }, alsoJoin: [opened.network], noProxy: opened.aliases, redactValues: opened.redactValues };
          const pack = await deps.runPack(context, planned(extra));
          return await finish(pack, { kind: "start", url: opened.target.baseUrl }, null, extra);
        } finally {
          await opened.close();
        }
      }
      const pack = await (parityPlan ? deps.runPack(context, planned({})) : deps.runPack(context));
      if (mode === "target") {
        const targets = repoPolicy?.qaTargets ?? [];
        const named = typeof (pack.detail?.answer as { target?: unknown } | undefined)?.target === "string" ? targets.find((t) => t.name === (pack.detail!.answer as { target: string }).target) : undefined;
        const chosen = named ?? targets[0];
        return finish(pack, chosen ? { kind: "target", url: chosen.baseUrl } : null, null, undefined);
      }
      return finish(pack, null, mode === "agent" ? "verify.e2e.start is not set: the agent booted its own dev server" : null, undefined);
    };
    /** Results a step after the browser run failed: their findings are final and are not judged for a cause. */
    const fromSteps = new WeakSet<StageResult>();
    const run = async (): Promise<StageResult> => {
      const a = await attempt();
      if ("done" in a) return a.done;
      let result = a.settled;
      for (const out of a.after) {
        if (out.escalate) return { ...out.escalate, usage: addUsage(result.usage, out.escalate.usage), detail: { ...out.escalate.detail, step: "e2e" } };
        result = { ...result, usage: addUsage(result.usage, out.usage), detail: { ...result.detail, ...(out.also ?? {}), [out.key]: out.detail } };
      }
      const blocking = a.after.filter((out) => out.blocking);
      if (blocking.length === 0) return result;
      // Findings the steps built: they go to Build as they are (a scenario failure's findings are built later, from the manifest).
      // A design blocker is its own failure: Build is sent back with the same-set rounds of Verify (`step: "design"`); the audit's alone stays an e2e failure.
      const step = blocking.some((out) => out.key === "parity") ? { step: "design" } : {};
      const failed: StageResult = { ...result, outcome: "fail", detail: { ...result.detail, ...step, verdict: blocking[0]!.key }, findings: blocking.flatMap((out) => out.findings ?? []).filter((f) => severityOf(f.severity) !== "nit") };
      fromSteps.add(failed);
      return failed;
    };
    /** Why a browser run failed, from the decision pack asked once per failed scenario (five at most): an `env_flake` only when every one is, a product bug when any is, else a test bug. */
    let causeRecord: string | undefined;
    const causeOf = async (result: StageResult): Promise<{ overall: Cause; per: Map<string, Cause> } | null> => {
      const decide = deps.decide ?? null;
      const detail = result.detail as { verdict?: string; summary?: string };
      if (!decide || (detail.verdict !== "fail" && detail.verdict !== "partial")) return null;
      const repoPath = context.task.repoPath ?? null;
      const failed = failedRows(result).filter((row): row is ScenarioRow & { result: "fail" | "partial" } => row.result === "fail" || row.result === "partial").slice(0, CAUSE_MAX);
      const per = new Map<string, Cause>();
      for (const row of failed) {
        const { verdict, answer, recordId } = await judgeCheck(
          decide,
          "e2e_failure_cause",
          { kind: "e2e", e2e: { verdict: detail.verdict, summary: detail.summary ?? "", criteria: [{ text: row.text, result: row.result }], attempt: context.attempt } },
          repoPath,
          (await deps.overrides?.(repoPath)) ?? {},
        );
        causeRecord ??= recordId;
        const choice = (answer?.cause as { choice?: unknown } | undefined)?.choice;
        const cause: Cause | null = (verdict === "proceed" || verdict === "flag") && (choice === "env_flake" || choice === "test_bug") ? choice : verdict === "skipped" ? null : "product_bug";
        if (cause) per.set(row.text, cause);
      }
      if (per.size === 0) return null;
      const all = [...per.values()];
      return { overall: all.every((c) => c === "env_flake") ? "env_flake" : all.includes("product_bug") ? "product_bug" : "test_bug", per };
    };
    /** What Build is given when the card goes back: one finding per scenario that did not pass, each with its own judged cause. */
    const withFindings = (r: StageResult, causes: ReadonlyMap<string, string> | null): StageResult => {
      if (r.outcome === "pass") return r;
      const d = r.detail as { summary?: unknown } | undefined;
      // Only what the machine built: whatever findings the container's own answer carried never reach Build, an empty list included.
      const findings = scenarioFindings(failedRows(r), typeof d?.summary === "string" ? d.summary : "", causes ?? null);
      return { ...r, findings };
    };

    let result = await run();
    if (result.outcome !== "fail" || fromSteps.has(result)) return result;
    const judgedCause = await causeOf(result);
    if (judgedCause === null) return withFindings(result, null);
    const cause = judgedCause.overall;
    if (cause !== "env_flake" || flakeRetries === 0) return withFindings({ ...result, detail: { ...result.detail, cause } }, judgedCause.per);
    // An environment flake: the scenario was never really tried, so once more before a person is asked.
    // The re-run writes into the same run folder: what the first attempt left there must not be read as its packet.
    await clearRun();
    result = await run();
    for (let more = 1; more < flakeRetries && result.outcome === "fail"; more++) {
      await clearRun();
      result = await run();
    }
    // The re-run is the fact: a pass says it was the environment, a second failure says it was not.
    if (causeRecord) await deps.truth?.learned({ pack: "e2e_failure_cause", recordId: causeRecord, label: e2eCauseTruth(result.outcome !== "fail"), kind: "fact", source: "e2e_rerun", taskId: context.task.id });
    if (result.outcome !== "fail") return { ...result, detail: { ...result.detail, rerun: true, cause } };
    const summary = String(result.detail?.summary ?? "");
    return withFindings({
      ...result,
      outcome: "escalated",
      detail: {
        ...result.detail,
        cause,
        rerun: true,
        escalation: "flaky_tests",
        reason: `e2e failed ${flakeRetries === 1 ? "twice" : `${flakeRetries + 1} times`} on what looks like an environment flake: ${summary}`,
        options: ["check the QA target or the dev server, then retry the task", "mark the scenario partial by hand"],
      },
    }, judgedCause.per);
  };
}

/** Stands in for e2e when the QA image is not built: the factory keeps going. */
export function missingQaImageRunner(): StageRunner {
  return async () => ({
    outcome: "pass",
    detail: {
      step: "e2e",
      skipped: true,
      note: "QA image missing (pnpm runner-qa:build); e2e skipped",
    },
  });
}
