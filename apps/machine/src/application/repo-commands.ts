// The repository's own commands, read from the user's checkout (never a card's folder: a card cannot turn its own scenario into a check):
// the root package.json's scripts, each workspace package's scripts (from package.json `workspaces` or pnpm-workspace.yaml, else one folder
// down), the script files under scripts/, and the luna.yaml checks. Build's tests step asks for no red test for a scenario that only runs
// one of them and expects it to pass (see domain/command-check.ts).
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import { repoCommandsOf } from "../domain/command-check.ts";

const MAX_JSON = 1024 * 1024;
const MAX_WORKSPACES = 200;
const MAX_SCRIPT_FILES = 300;
const SCRIPT_FILE = /\.(?:m?[jt]s|cjs|cts|sh)$/;

type Workspace = { name: string; dir: string; scripts: string[] };

const json = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readRegularFile(path, MAX_JSON)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** A real folder inside the repo, never a link: a workspace or script that points outside the checkout is not the repo's. */
const isRealDir = async (path: string): Promise<boolean> => {
  const info = await lstat(path).catch(() => null);
  return info !== null && info.isDirectory() && !info.isSymbolicLink();
};

/** The workspace patterns: package.json `workspaces` (an array, or `{ packages }`), else pnpm-workspace.yaml's `packages` list. */
async function patternsOf(repoPath: string, pkg: Record<string, unknown> | null): Promise<string[]> {
  const ws = pkg?.workspaces;
  const fromPkg = Array.isArray(ws) ? ws : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  if (fromPkg.length > 0) return fromPkg.filter((p): p is string => typeof p === "string");
  const yaml = await readRegularFile(join(repoPath, "pnpm-workspace.yaml"), MAX_JSON).catch(() => "");
  const block = /^packages:\s*\n((?:\s+-.*\n?)*)/m.exec(yaml)?.[1] ?? "";
  return [...block.matchAll(/^\s+-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]!.trim());
}

/** The folders a pattern names: `dir`, `dir/*` and `a/b/*`; a negation, `**` or any other glob is left out. */
async function dirsOf(repoPath: string, pattern: string): Promise<string[]> {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || clean.startsWith("!") || clean.includes("**") || clean.includes("..")) return [];
  if (!clean.includes("*")) return (await isRealDir(join(repoPath, clean))) ? [clean] : [];
  if (!clean.endsWith("/*") || clean.slice(0, -2).includes("*")) return [];
  const parent = clean.slice(0, -2);
  if (!(await isRealDir(join(repoPath, parent)))) return [];
  const entries = await readdir(join(repoPath, parent), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => `${parent}/${e.name}`);
}

async function workspacesOf(repoPath: string, pkg: Record<string, unknown> | null): Promise<Workspace[]> {
  const patterns = await patternsOf(repoPath, pkg);
  const negated = new Set(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/^\.\//, "").replace(/\/+$/, "")));
  let dirs: string[] = [];
  for (const pattern of patterns) dirs.push(...(await dirsOf(repoPath, pattern)));
  if (patterns.length === 0) {
    // No workspaces declared: each package one folder down, as before.
    const entries = await readdir(repoPath, { withFileTypes: true }).catch(() => []);
    dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name);
  }
  const out: Workspace[] = [];
  for (const dir of [...new Set(dirs)].filter((d) => !negated.has(d)).slice(0, MAX_WORKSPACES)) {
    if (!(await isRealDir(join(repoPath, dir)))) continue;
    const parsed = await json(join(repoPath, dir, "package.json"));
    if (parsed && typeof parsed.name === "string" && parsed.name) out.push({ name: parsed.name, dir, scripts: Object.keys((parsed.scripts as Record<string, unknown> | undefined) ?? {}) });
  }
  return out;
}

/** The script files under scripts/ (three folders deep at most), as repo-relative paths; a link is never followed. */
async function scriptFilesOf(repoPath: string): Promise<string[]> {
  const root = resolve(repoPath, "scripts");
  if (!(await isRealDir(root))) return [];
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= MAX_SCRIPT_FILES) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_SCRIPT_FILES) return;
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && SCRIPT_FILE.test(entry.name)) out.push(relative(repoPath, path).split("\\").join("/"));
    }
  };
  await walk(root, 1);
  return out.sort();
}

/** The repo's own commands, for `isCommandCheck`. */
export async function readRepoCommands(repoPath: string, checkRuns: readonly string[]): Promise<string[]> {
  const pkg = await json(resolve(repoPath, "package.json"));
  const scripts = Object.keys((pkg?.scripts as Record<string, unknown> | undefined) ?? {});
  return repoCommandsOf(scripts, checkRuns, await workspacesOf(repoPath, pkg), await scriptFilesOf(repoPath));
}
