// The machine installs a repository's dependencies from its lockfile, before the agent runs, in a container that holds no credential,
// no secret and none of the run's folders. The order: the repository's image and its id; the lockfiles' blob ids at the commit from the
// card's repository (never the folder); the key; the stamp the machine keeps outside the folder. Same key and, for a Node plan, a
// node_modules folder: nothing runs. The user's checkout decides the flags (scripts, yarn berry); the card's folder decides nothing.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type SandboxExec, cacheVolumeFor } from "../adapters/docker/docker.ts";
import type { BlockedRow } from "../adapters/docker/egress.ts";
import type { ExecResult } from "../adapters/process/exec.ts";
import { LOCKFILES } from "../domain/env-hash.ts";
import { safe } from "../domain/evidence-markdown.ts";
import { type InstallStep, argvIn, installKey, installPlanOf, nestedPlansOf } from "../domain/install-plan.ts";
import type { EgressPolicy } from "./egress-policy.ts";
import type { PolicyStore } from "./policy.ts";

const STEP_TIMEOUT_MS = 30 * 60_000;
const TAIL_LINES = 40;

export interface InstallDeps {
  stateDir: string;
  policies: Pick<PolicyStore, "for">;
  repoImages: { ensure(repoPath: string, signal?: AbortSignal, taskId?: string): Promise<{ image: string }> };
  imageId(image: string): Promise<string>;
  lockfilesAt(path: string, commit: string, names: readonly string[]): Promise<Record<string, string>>;
  /** The lockfiles below the root at `commit` in the card's repository, path → blob id (`nestedLockfilesAt`); absent, only the root's install. */
  nestedLockfilesAt?(path: string, commit: string, names: readonly string[]): Promise<Record<string, string>>;
  exec(run: SandboxExec, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult & { blocked?: BlockedRow[] }>;
  egress?: EgressPolicy;
  /** Whether the USER's checkout has a `.yarnrc.yml`. */
  yarnBerry?(repoPath: string): Promise<boolean>;
  hasNodeModules?(workspace: string): Promise<boolean>;
  /** The package-manager configuration files (`.yarnrc.yml`, `.yarnrc`, `.npmrc`) the card changed from the user's checkout at the card's base: any makes the install refused. */
  configChanged(input: { workspace: string; repoPath: string; commit: string; dirs?: readonly string[] }): Promise<string[]>;
  removeNested(path: string): string[];
  dirtyFiles(path: string): Promise<string[]>;
  restoreFiles(path: string, ref: string, files: string[]): Promise<void>;
}

export interface InstallInput {
  taskId: string;
  repoPath: string;
  workspace: string;
  commit: string;
  signal?: AbortSignal;
}

export type InstallOutcome =
  | { ok: true; ran: string[]; notes: string[]; blocked: BlockedRow[] }
  | { ok: false; detail: Record<string, unknown>; blocked: BlockedRow[] };

/** The files a package manager reads for code or hooks. */
export const PACKAGE_MANAGER_CONFIG = [".yarnrc.yml", ".yarnrc", ".npmrc"] as const;

/** The configuration files whose blob in the card's repository at `commit` differs from the user's checkout at the card's base (compared by blob id through git, never by reading the card's folder); with no base known, any the card has. */
export async function configFilesChanged(
  git: { cardBlobs(workspace: string, commit: string, names: readonly string[]): Promise<Record<string, string>>; userBlobs(repoPath: string, base: string, names: readonly string[]): Promise<Record<string, string>>; baseOf(workspace: string, repoPath: string): Promise<string | null> },
  input: { workspace: string; repoPath: string; commit: string; dirs?: readonly string[] },
): Promise<string[]> {
  // The root's files, and those of each subfolder the install runs in (`tools/web/.npmrc`).
  const names = [...PACKAGE_MANAGER_CONFIG, ...(input.dirs ?? []).flatMap((dir) => PACKAGE_MANAGER_CONFIG.map((name) => `${dir}/${name}`))];
  const card = await git.cardBlobs(input.workspace, input.commit, names);
  const base = await git.baseOf(input.workspace, input.repoPath);
  const user = base ? await git.userBlobs(input.repoPath, base, names) : {};
  if (!base) return names.filter((name) => name in card);
  return names.filter((name) => card[name] !== user[name]);
}

/** Thrown by a checks executor when the install before a check failed: the stage that ran the check escalates with `detail`. */
export class InstallFailedError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.reason ?? "the install failed"));
    this.name = "InstallFailedError";
  }
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
const tail = (text: string): string => safe(text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n")).slice(0, 2000);

/** Installs when the key says the folder's dependencies are not those of the lockfiles; see the file's head. */
export async function ensureInstalled(deps: InstallDeps, input: InstallInput): Promise<InstallOutcome> {
  const policy = await deps.policies.for(input.repoPath);
  const { run, scripts } = policy.factory.sandbox.install;
  const none: InstallOutcome = { ok: true, ran: [], notes: [], blocked: [] };
  if (run === "off") return none;
  const image = (await deps.repoImages.ensure(input.repoPath, input.signal, input.taskId)).image;
  const id = await deps.imageId(image);
  const lockfiles = await deps.lockfilesAt(input.workspace, input.commit, LOCKFILES);
  // A lockfile in a subfolder (a Rust crate in `board/`, a Node app in `tools/web/` that is not a workspace member) is installed in its folder.
  const nested = deps.nestedLockfilesAt ? await deps.nestedLockfilesAt(input.workspace, input.commit, LOCKFILES) : {};
  const key = installKey({ image: id, lockfiles: { ...lockfiles, ...nested }, scripts });
  const berryAt = deps.yarnBerry ?? ((repo: string) => exists(join(repo, ".yarnrc.yml")));
  const rootBerry = await berryAt(input.repoPath);
  const plan = installPlanOf(Object.keys(lockfiles), { scripts: scripts === "on", yarnBerry: rootBerry });
  const dirsOf = (paths: string[]) => [...new Set(paths.map((p) => p.slice(0, p.lastIndexOf("/"))))];
  const berry = new Map<string, boolean>();
  for (const dir of dirsOf(Object.keys(nested))) berry.set(dir, rootBerry || (await berryAt(join(input.repoPath, dir))));
  const sub = nestedPlansOf(Object.keys(nested), (dir) => ({ scripts: scripts === "on", yarnBerry: berry.get(dir) ?? rootBerry }));
  const notes = [...plan.skipped, ...sub.skipped].map((s) => s.note);
  const steps: InstallStep[] = [...plan.steps, ...sub.steps];
  if (steps.length === 0) return { ...none, notes };

  const stamp = join(deps.stateDir, "tasks", input.taskId, "install", `${createHash("sha1").update(input.workspace).digest("hex")}.json`);
  const stamped = await readFile(stamp, "utf8").then((t) => (JSON.parse(t) as { key?: string }).key, () => undefined);
  const hasModules = deps.hasNodeModules ?? ((w: string) => exists(join(w, "node_modules")));
  const moduleDirs = [...new Set(steps.filter((s) => s.node).map((s) => (s.dir ? join(input.workspace, s.dir) : input.workspace)))];
  if (stamped === key && (await Promise.all(moduleDirs.map((d) => hasModules(d)))).every(Boolean)) return { ...none, notes };

  const subDirs = dirsOf(sub.steps.map((s) => s.lockfile));
  const changedConfig = await deps.configChanged({ workspace: input.workspace, repoPath: input.repoPath, commit: input.commit, ...(subDirs.length ? { dirs: subDirs } : {}) });
  if (changedConfig.length > 0) {
    return {
      ok: false,
      blocked: [],
      detail: { escalation: "env_broken", envBroken: true, step: "install", reason: `the card changes ${changedConfig.join(", ")}, which differs from the repository's own: the machine installs only with the repository's own package-manager configuration, because that configuration can run code`, options: ["land the configuration change in the repository itself, or take it out of the card, then resume"] },
    };
  }
  const spec = deps.egress ? await deps.egress.for({ repoPath: input.repoPath, kind: "install" }) : undefined;
  const blocked: BlockedRow[] = [];
  const ran: string[] = [];
  for (const step of steps) {
    // No `secrets`, no credential, no /in, /out, /session or /graph: the spec has nothing of the run's.
    const result = await deps.exec(
      {
        name: `hardness-install-${randomUUID().slice(0, 8)}`,
        image,
        worktree: input.workspace,
        limits: { cpu: policy.factory.sandbox.cpu, memoryGb: policy.factory.sandbox.memory_gb },
        argv: argvIn(step),
        env: step.env,
        cacheVolume: cacheVolumeFor(input.repoPath),
        ...(spec ? { egress: spec } : {}),
      },
      { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: STEP_TIMEOUT_MS },
    );
    blocked.push(...(result.blocked ?? []));
    if (result.code !== 0) {
      const why = result.code === 127 ? `\`${step.tool}\` is not in the repository's image` : `\`${step.argv.join(" ")}\` failed (exit ${result.code})`;
      // A subfolder's install that fails is said, not a stop: the root's dependencies are in, and a check that needs the subfolder's shows it.
      if (step.dir) {
        notes.push(`${why}, installing from ${step.lockfile}: a check under ${step.dir} may fail for it (${safe(`${result.stderr || result.stdout}`.trim().split("\n").at(-1) ?? "").slice(0, 200)})`);
        continue;
      }
      return {
        ok: false,
        blocked,
        detail: { escalation: "env_broken", envBroken: true, step: "install", tool: step.tool, lockfile: step.lockfile, reason: `${why}, installing from ${step.lockfile}`, logTail: tail(`${result.stdout}\n${result.stderr}`), options: ["fix the lockfile or the image (sandbox.image.base), or set sandbox.install.run: off in luna.yaml, then resume"] },
      };
    }
    ran.push(`${step.dir ? `${step.dir}: ` : ""}${step.argv.join(" ")}`);
  }
  // An install cannot change the card's code: a nested repository is removed, a tracked file it touched is put back.
  const leftRepos = deps.removeNested(input.workspace);
  if (leftRepos.length > 0) notes.push(`the install left a nested repository (${leftRepos.join(", ")}); it was removed`);
  const changed = (await deps.dirtyFiles(input.workspace)).filter((line) => !line.startsWith("??")).map((line) => line.slice(3));
  if (changed.length > 0) {
    await deps.restoreFiles(input.workspace, input.commit, changed);
    notes.push(`restored tracked files the install changed (${changed.slice(0, 10).join(", ")})`);
  }
  await mkdir(join(stamp, ".."), { recursive: true });
  await writeFile(stamp, JSON.stringify({ key }));
  return { ok: true, ran, notes, blocked };
}
