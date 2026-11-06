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
import { installKey, installPlanOf } from "../domain/install-plan.ts";
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
  exec(run: SandboxExec, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult & { blocked?: BlockedRow[] }>;
  egress?: EgressPolicy;
  /** Whether the USER's checkout has a `.yarnrc.yml`. */
  yarnBerry?(repoPath: string): Promise<boolean>;
  hasNodeModules?(workspace: string): Promise<boolean>;
  /** The package-manager configuration files (`.yarnrc.yml`, `.yarnrc`, `.npmrc`) the card changed from the user's checkout at the card's base: any makes the install refused. */
  configChanged(input: { workspace: string; repoPath: string; commit: string }): Promise<string[]>;
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
  git: { cardBlobs(workspace: string, commit: string): Promise<Record<string, string>>; userBlobs(repoPath: string, base: string): Promise<Record<string, string>>; baseOf(workspace: string, repoPath: string): Promise<string | null> },
  input: { workspace: string; repoPath: string; commit: string },
): Promise<string[]> {
  const card = await git.cardBlobs(input.workspace, input.commit);
  const base = await git.baseOf(input.workspace, input.repoPath);
  const user = base ? await git.userBlobs(input.repoPath, base) : {};
  if (!base) return PACKAGE_MANAGER_CONFIG.filter((name) => name in card);
  return PACKAGE_MANAGER_CONFIG.filter((name) => card[name] !== user[name]);
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
  const key = installKey({ image: id, lockfiles, scripts });
  const plan = installPlanOf(Object.keys(lockfiles), { scripts: scripts === "on", yarnBerry: await (deps.yarnBerry ?? ((repo: string) => exists(join(repo, ".yarnrc.yml"))))(input.repoPath) });
  const notes = plan.skipped.map((s) => s.note);
  if (plan.steps.length === 0) return { ...none, notes };

  const stamp = join(deps.stateDir, "tasks", input.taskId, "install", `${createHash("sha1").update(input.workspace).digest("hex")}.json`);
  const stamped = await readFile(stamp, "utf8").then((t) => (JSON.parse(t) as { key?: string }).key, () => undefined);
  const needsModules = plan.steps.some((s) => s.node);
  if (stamped === key && (!needsModules || (await (deps.hasNodeModules ?? ((w: string) => exists(join(w, "node_modules"))))(input.workspace)))) return { ...none, notes };

  const changedConfig = await deps.configChanged({ workspace: input.workspace, repoPath: input.repoPath, commit: input.commit });
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
  for (const step of plan.steps) {
    // No `secrets`, no credential, no /in, /out, /session or /graph: the spec has nothing of the run's.
    const result = await deps.exec(
      {
        name: `hardness-install-${randomUUID().slice(0, 8)}`,
        image,
        worktree: input.workspace,
        limits: { cpu: policy.factory.sandbox.cpu, memoryGb: policy.factory.sandbox.memory_gb },
        argv: step.argv,
        env: step.env,
        cacheVolume: cacheVolumeFor(input.repoPath),
        ...(spec ? { egress: spec } : {}),
      },
      { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: STEP_TIMEOUT_MS },
    );
    blocked.push(...(result.blocked ?? []));
    if (result.code !== 0) {
      const why = result.code === 127 ? `\`${step.tool}\` is not in the repository's image` : `\`${step.argv.join(" ")}\` failed (exit ${result.code})`;
      return {
        ok: false,
        blocked,
        detail: { escalation: "env_broken", envBroken: true, step: "install", tool: step.tool, lockfile: step.lockfile, reason: `${why}, installing from ${step.lockfile}`, logTail: tail(`${result.stdout}\n${result.stderr}`), options: ["fix the lockfile or the image (sandbox.image.base), or set sandbox.install.run: off in luna.yaml, then resume"] },
      };
    }
    ran.push(step.argv.join(" "));
  }
  // An install cannot change the card's code: a nested repository is removed, a tracked file it touched is put back.
  const nested = deps.removeNested(input.workspace);
  if (nested.length > 0) notes.push(`the install left a nested repository (${nested.join(", ")}); it was removed`);
  const changed = (await deps.dirtyFiles(input.workspace)).filter((line) => !line.startsWith("??")).map((line) => line.slice(3));
  if (changed.length > 0) {
    await deps.restoreFiles(input.workspace, input.commit, changed);
    notes.push(`restored tracked files the install changed (${changed.slice(0, 10).join(", ")})`);
  }
  await mkdir(join(stamp, ".."), { recursive: true });
  await writeFile(stamp, JSON.stringify({ key }));
  return { ok: true, ran, notes, blocked };
}
