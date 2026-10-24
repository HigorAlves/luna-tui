// The e2e stage: skip repos with no web surface, otherwise run the e2e pack in the QA image
// and turn its verdict into a pass or a fail for the e2e loop.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { StageContext, StageResult, StageRunner } from "../ports.ts";

export interface E2eDeps {
  /** Runs the e2e pack. */
  runPack: (context: StageContext) => Promise<StageResult>;
  detectWeb?: (worktreePath: string) => Promise<boolean>;
}

const WEB_SCRIPTS = ["dev", "start", "preview"];
const WEB_FRAMEWORKS = ["next", "vite", "react", "vue", "svelte", "astro", "nuxt", "remix"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor"]);

const isFile = (path: string) => stat(path).then((s) => s.isFile(), () => false);

/** True when the worktree looks like something a browser can open. */
export async function detectWeb(worktreePath: string): Promise<boolean> {
  if (await isFile(join(worktreePath, ".orc", "targets.json"))) return true;
  try {
    const pkg = JSON.parse(await readFile(join(worktreePath, "package.json"), "utf8")) as Record<string, unknown>;
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    if (WEB_SCRIPTS.some((name) => typeof scripts[name] === "string")) return true;
    const deps = { ...((pkg.dependencies ?? {}) as object), ...((pkg.devDependencies ?? {}) as object) };
    if (WEB_FRAMEWORKS.some((name) => name in deps)) return true;
  } catch {
    // no package.json, or not JSON: look for html next
  }
  if (await isFile(join(worktreePath, "index.html"))) return true;
  try {
    for (const entry of await readdir(worktreePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (await isFile(join(worktreePath, entry.name, "index.html"))) return true;
    }
  } catch {
    // unreadable worktree: no web surface
  }
  return false;
}

export function e2eRunner(deps: E2eDeps): StageRunner {
  const detect = deps.detectWeb ?? detectWeb;
  return async (context) => {
    const worktree = context.task.worktreePath;
    if (!worktree || !(await detect(worktree))) {
      return { outcome: "pass", detail: { step: "e2e", skipped: true, reason: "no web surface detected" } };
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
