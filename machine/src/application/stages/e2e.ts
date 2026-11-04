// The e2e stage: skip repos with no web surface and changes that touch none of it; otherwise
// run the e2e pack in the QA image and turn its verdict into a pass or a fail for the e2e loop.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { branchBase, diffNameStatus } from "../../adapters/git/worktree.ts";
import type { DecisionOverrides } from "@hardness/contracts";

import type { Policy } from "../../domain/policy.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";

export interface E2eDeps {
  /** Runs the e2e pack. */
  runPack: (context: StageContext) => Promise<StageResult>;
  detectWeb?: (worktreePath: string) => Promise<boolean>;
  /** The web package dirs, relative ("" is the root); their src/ counts as rendered surface. */
  webRoots?: (worktreePath: string) => Promise<string[]>;
  /** Paths the task branch changed; null when the base is unknown (then the pack runs). */
  changedFiles?: (worktreePath: string, repoPath: string | null) => Promise<string[] | null>;
  /** The repo's config: `qa: none` means this repo never gets a browser run. */
  policy?: (repoPath: string | null) => Promise<Pick<Policy, "qa">>;
  /** Runs e2e_failure_cause on a failed run; null (or absent) leaves a failure as it is. Read at call time. */
  decide?: Decide | null;
  /** The repo's per-pack decision bars. */
  overrides?: (repoPath: string | null) => Promise<Record<string, DecisionOverrides>>;
}

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
    if (deps.policy && (await deps.policy(context.task.repoPath ?? null)).qa === "none") {
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
    const settle = (pack: StageResult): StageResult => {
      if (pack.outcome !== "pass") return { ...pack, detail: { ...pack.detail, step: "e2e" } };
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
          ...(verdict === "skipped" ? { skipped: true, note: `e2e skipped by the QA agent: ${summary}` } : {}),
          ...(verdict ? {} : { error: "the e2e pack gave no verdict" }),
        },
      };
    };
    /** Why a browser run failed, from the decision pack: an `env_flake` only when it is confident, else the app's fault. */
    const causeOf = async (result: StageResult): Promise<Cause | null> => {
      const decide = deps.decide ?? null;
      const detail = result.detail as { verdict?: string; summary?: string; criteria?: Array<{ text: string; result: string }> };
      if (!decide || (detail.verdict !== "fail" && detail.verdict !== "partial")) return null;
      const repoPath = context.task.repoPath ?? null;
      const rows = (detail.criteria ?? []).filter((c) => c.result !== "pass").map((c) => ({ text: c.text, result: c.result as "fail" | "partial" }));
      const { verdict, answer } = await judgeCheck(
        decide,
        "e2e_failure_cause",
        { kind: "e2e", e2e: { verdict: detail.verdict, summary: detail.summary ?? "", criteria: rows, attempt: context.attempt } },
        repoPath,
        (await deps.overrides?.(repoPath)) ?? {},
      );
      const choice = (answer?.cause as { choice?: unknown } | undefined)?.choice;
      return (verdict === "proceed" || verdict === "flag") && (choice === "env_flake" || choice === "test_bug") ? choice : verdict === "skipped" ? null : "product_bug";
    };

    let result = settle(await deps.runPack(context));
    if (result.outcome !== "fail") return result;
    const cause = await causeOf(result);
    if (cause === null) return result;
    if (cause !== "env_flake") return { ...result, detail: { ...result.detail, cause } };
    // An environment flake: the scenario was never really tried, so once more before a person is asked.
    result = settle(await deps.runPack(context));
    if (result.outcome !== "fail") return { ...result, detail: { ...result.detail, rerun: true, cause } };
    const summary = String(result.detail?.summary ?? "");
    return {
      ...result,
      outcome: "escalated",
      detail: {
        ...result.detail,
        cause,
        rerun: true,
        escalation: "flaky_tests",
        reason: `e2e failed twice on what looks like an environment flake: ${summary}`,
        options: ["check the QA target or the dev server, then retry the task", "mark the scenario partial by hand"],
      },
    };
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
