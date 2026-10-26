// The e2e stage: skip repos with no web surface and changes that touch none of it; otherwise
// run the e2e pack in the QA image and turn its verdict into a pass or a fail for the e2e loop.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { branchBase, diffNameStatus } from "../../adapters/git/worktree.ts";
import type { Policy } from "../../domain/policy.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

export interface E2eDeps {
  /** Runs the e2e pack. */
  runPack: (context: StageContext) => Promise<StageResult>;
  detectWeb?: (worktreePath: string) => Promise<boolean>;
  /** The web package dirs, relative ("" is the root); their src/ counts as rendered surface. */
  webRoots?: (worktreePath: string) => Promise<string[]>;
  /** Paths the task branch changed; null when the base is unknown (then the pack runs). */
  changedFiles?: (worktreePath: string, repoPath: string | null) => Promise<string[] | null>;
  /** The repo's PIPELINE.md: `qa: none` means this repo never gets a browser run. */
  policy?: (repoPath: string | null) => Promise<Pick<Policy, "qa">>;
}

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
 *  package (or carries an index.html / .orc/targets.json), plus each workspace app that is. */
export async function webRoots(worktreePath: string): Promise<string[]> {
  const roots: string[] = [];
  if (
    (await isFile(join(worktreePath, ".orc", "targets.json"))) ||
    (await webPackage(worktreePath)) ||
    (await isFile(join(worktreePath, "index.html")))
  ) {
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
      return { outcome: "pass", detail: { step: "e2e", skipped: true, reason: "PIPELINE.md says qa: none" } };
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
    const pack = await deps.runPack(context);
    if (pack.outcome !== "pass") return { ...pack, detail: { ...pack.detail, step: "e2e" } };

    const answer = (pack.detail?.answer ?? {}) as Record<string, unknown>;
    const verdict = typeof answer.verdict === "string" ? answer.verdict : undefined;
    // `skipped` is not a result.json outcome; orc reports it as a pass, and so do we.
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
