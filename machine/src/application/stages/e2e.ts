// The e2e stage: skip repos with no web surface and changes that touch none of it; otherwise
// run the e2e pack in the QA image and turn its verdict into a pass or a fail for the e2e loop.
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { branchBase, diffNameStatus, headCommit } from "../../adapters/git/worktree.ts";
import type { DecisionOverrides } from "@hardness/contracts";

import type { Policy } from "../../domain/policy.ts";
import { type ManifestRow, boundedArtifacts, manifestRows } from "../../domain/e2e-manifest.ts";
import { approvedScenarios } from "../../domain/stage-input.ts";
import { type ScenarioRow, scenarioFindings } from "../../domain/send-back.ts";
import { type OpenAppInput, type OpenAppResult, type OpenPreviewResult, e2eModeOf } from "../app-session.ts";
import { blockedPayloads } from "../egress-policy.ts";
import type { AgentExtra } from "./pack-runner.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type TruthSink, e2eCauseTruth } from "../decision-truth.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";

export interface E2eDeps {
  /** Runs the e2e pack; `extra` names the one target the machine chose (the app it started), the network to join and the names to reach directly. */
  runPack: (context: StageContext, extra?: Pick<AgentExtra, "qaTarget" | "alsoJoin" | "noProxy" | "redactValues">) => Promise<StageResult>;
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

/** How many failed scenarios the cause decision is asked about. */
const CAUSE_MAX = 5;
type Cause = "product_bug" | "test_bug" | "env_flake";

const WEB_SCRIPTS = ["dev", "start", "preview"];
const WEB_FRAMEWORKS = ["next", "vite", "react", "vue", "svelte", "astro", "nuxt", "remix"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor"]);
/** Where a monorepo keeps its apps: one level of these is scanned for a web package.json. */
const WORKSPACE_DIRS = ["apps", "packages", "services", "sites"];
/** A file the browser renders, or the folder such files live in; `package.json` because a
 *  dependency bump changes what renders too. */
const RENDERED_EXT = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|mdx|j2|hbs|ejs|svg|png|jpe?g|gif|webp|woff2?)$/i;
const RENDERED_DIRS = new Set(["app", "pages", "components", "public", "static", "views", "templates", "ui", "assets", "styles"]);

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

/** True when any changed path is something on screen could depend on. */
export function touchesRenderedSurface(files: string[], webRootDirs: string[] = []): boolean {
  return files.some((file) => {
    const parts = file.split("/");
    const name = parts.at(-1) ?? "";
    if (name === "package.json" || RENDERED_EXT.test(name) || parts.slice(0, -1).some((dir) => RENDERED_DIRS.has(dir))) return true;
    // Inside a web package, any source under src/ may render the page (a .ts that builds the
    // DOM looks like any other .ts); only tests are known not to.
    if (TEST_PATH.test(file)) return false;
    return webRootDirs.some((root) => file.startsWith(root === "" ? "src/" : `${root}/src/`));
  });
}
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$/i;

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
    const scenarios = approvedScenarios(context.approvals).map((sc) => ({ id: sc.id ?? "", title: sc.title, criterion_ref: sc.criterion_ref ?? null }));
    const qaDir = deps.stateDir ? join(deps.stateDir, "runs", context.runId, "files", "qa") : null;
    /** The manifest the machine checks by script: one row per approved scenario, artifacts only when they are plain-named regular files in the run's folder; a scenario with no row is not run, which fails a passing verdict. */
    const judged = async (r: StageResult): Promise<StageResult> => {
      const d = r.detail as { criteria?: unknown[]; summary?: unknown; verdict?: string; skipped?: boolean } | undefined;
      if (scenarios.length === 0 || d?.skipped === true || (r.outcome !== "pass" && r.outcome !== "fail")) return r;
      const rows = manifestRows(scenarios, d?.criteria ?? [], typeof d?.summary === "string" ? d.summary : "");
      for (const row of rows) row.artifacts = await boundedArtifacts(row.artifacts, qaDir);
      const incomplete = rows.some((row) => row.result === "not_run");
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
    type Attempted = { done: StageResult } | { pack: StageResult; preview: { kind: string; url: string } | null; note: string | null };
    const attempt = async (): Promise<Attempted> => {
      const e2e = repoPolicy?.factory?.verify.e2e;
      const mode = repoPolicy && e2e ? e2eModeOf({ qaTargets: repoPolicy.qaTargets ?? [], factory: { verify: { e2e } } as never }) : "agent";
      const repoPath = context.task.repoPath ?? null;
      if (mode === "deploy" && deps.openPreview && repoPath) {
        const preview = await deps.openPreview({
          taskId: context.task.id,
          repoPath,
          workspace: worktree,
          commit: await (deps.headCommit ?? headCommit)(worktree),
          branch: context.task.branch ?? "",
          attempt: context.attempt * 10 + runs++,
          signal: context.signal,
          onBlocked: (step, rows) => void Promise.all(blockedPayloads(rows, step).map((payload) => context.emit?.("sandbox.egress_blocked", payload))).catch(() => {}),
        });
        if (!preview.ok) return { done: { outcome: "escalated", detail: preview.detail } };
        try {
          const pack = await deps.runPack(context, { qaTarget: { ...preview.target, credential: null }, redactValues: preview.redactValues });
          return { pack, preview: { kind: "deploy", url: preview.target.baseUrl }, note: null };
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
          signal: context.signal,
          onBlocked: (step, rows) => void Promise.all(blockedPayloads(rows, step).map((payload) => context.emit?.("sandbox.egress_blocked", payload))).catch(() => {}),
        });
        if (!opened.ok) return { done: { outcome: "escalated", detail: opened.detail } };
        try {
          const pack = await deps.runPack(context, { qaTarget: { ...opened.target, credential: null }, alsoJoin: [opened.network], noProxy: opened.aliases, redactValues: opened.redactValues });
          return { pack, preview: { kind: "start", url: opened.target.baseUrl }, note: null };
        } finally {
          await opened.close();
        }
      }
      const pack = await deps.runPack(context);
      if (mode === "target") {
        const targets = repoPolicy?.qaTargets ?? [];
        const named = typeof (pack.detail?.answer as { target?: unknown } | undefined)?.target === "string" ? targets.find((t) => t.name === (pack.detail!.answer as { target: string }).target) : undefined;
        const chosen = named ?? targets[0];
        return { pack, preview: chosen ? { kind: "target", url: chosen.baseUrl } : null, note: null };
      }
      return { pack, preview: null, note: mode === "agent" ? "verify.e2e.start is not set: the agent booted its own dev server" : null };
    };
    const run = async (): Promise<StageResult> => {
      const a = await attempt();
      return "done" in a ? a.done : judged(settle([a.pack, a.preview, a.note]));
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
    if (result.outcome !== "fail") return result;
    const judgedCause = await causeOf(result);
    if (judgedCause === null) return withFindings(result, null);
    const cause = judgedCause.overall;
    if (cause !== "env_flake" || flakeRetries === 0) return withFindings({ ...result, detail: { ...result.detail, cause } }, judgedCause.per);
    // An environment flake: the scenario was never really tried, so once more before a person is asked.
    // The re-run writes into the same run folder: what the first attempt left there must not be read as its packet.
    if (deps.stateDir) await rm(join(deps.stateDir, "runs", context.runId, "out"), { recursive: true, force: true });
    result = await run();
    for (let more = 1; more < flakeRetries && result.outcome === "fail"; more++) {
      if (deps.stateDir) await rm(join(deps.stateDir, "runs", context.runId, "out"), { recursive: true, force: true });
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
