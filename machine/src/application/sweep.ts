// The retention sweep, nightly and at boot: what a long-running machine leaves on disk
// otherwise. Closed tasks keep their row; their checkout, their merged branch, run folders
// nobody owns and runner images nobody runs go.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { DataSource } from "typeorm";

import { HOST_GIT } from "../adapters/git/worktree.ts";
import { TaskEntity } from "../adapters/persistence/schemas.ts";
import { type ExecResult, exec } from "../adapters/process/exec.ts";
import { DATADOG_TRIAGE_DIR } from "./stages/datadog-triage-runner.ts";
import { SLACK_TRIAGE_DIR } from "./stages/slack-triage-runner.ts";

export interface WorktreeSweep {
  worktrees: number;
  branches: number;
}

/** Removes the worktree of every task closed more than `days` ago, deletes its branch when
 *  merged (`git branch -d` refuses otherwise, and that is the point), and clears the path on
 *  the row. 0 disables it. */
export async function sweepWorktrees(db: DataSource, days: number): Promise<WorktreeSweep> {
  const result = { worktrees: 0, branches: 0 };
  if (days <= 0) return result;
  const rows: { id: string; repo_path: string; worktree_path: string; branch: string | null }[] = await db.query(
    `select id, repo_path, worktree_path, branch from tasks
      where state = 'closed' and worktree_path is not null and repo_path is not null
        and updated_at < now() - make_interval(days => $1)`,
    [days],
  );
  const repos = new Set<string>();
  for (const row of rows) {
    const removed = await exec("git", [...HOST_GIT, "-C", row.repo_path, "worktree", "remove", "--force", row.worktree_path]);
    // Already gone from disk: prune the registration, the row still needs clearing.
    if (removed.code !== 0) await exec("git", [...HOST_GIT, "-C", row.repo_path, "worktree", "prune"]);
    await db.getRepository(TaskEntity).update({ id: row.id }, { worktreePath: null });
    result.worktrees++;
    repos.add(row.repo_path);
    if (row.branch && (await exec("git", [...HOST_GIT, "-C", row.repo_path, "branch", "-d", row.branch])).code === 0) {
      result.branches++;
    }
  }
  for (const repoPath of repos) await exec("git", [...HOST_GIT, "-C", repoPath, "worktree", "prune"]);
  return result;
}

/** Removes `<stateDir>/runs/<id>` folders with no stage_runs row: a deleted task orphans its
 *  runs' folders, and prune only removes the folders of the rows it deletes. */
export async function sweepRunFolders(db: DataSource, stateDir: string): Promise<number> {
  const runsDir = join(stateDir, "runs");
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const owned = new Set(((await db.query("select id from stage_runs")) as { id: string }[]).map((r) => r.id));
  const orphans = names.filter((name) => !owned.has(name));
  await Promise.all(orphans.map((name) => rm(join(runsDir, name), { recursive: true, force: true })));
  return orphans.length;
}

/** A slack_triage run folder is named by its start time (`2026-10-28T12-00-00-000Z`, `-2` for a second batch). */
const RUN_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

/** Removes `<stateDir>/slack-triage/<stamp>` folders older than `days`: a run that answered
 *  removes its own folder, so these are the failed runs' transcripts, kept as long as the
 *  stage runs' history. 0 disables it. Returns how many went. */
export function sweepSlackTriageRuns(stateDir: string, days: number, now: Date = new Date()): Promise<number> {
  return sweepTriageRuns(join(stateDir, SLACK_TRIAGE_DIR), days, now);
}

/** The same for `<stateDir>/datadog-triage`. */
export function sweepDatadogTriageRuns(stateDir: string, days: number, now: Date = new Date()): Promise<number> {
  return sweepTriageRuns(join(stateDir, DATADOG_TRIAGE_DIR), days, now);
}

async function sweepTriageRuns(dir: string, days: number, now: Date): Promise<number> {
  if (days <= 0) return 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - days * 86_400_000;
  let removed = 0;
  for (const name of names) {
    const match = RUN_STAMP.exec(name);
    const startedAt = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : (await stat(join(dir, name)).catch(() => null))?.mtimeMs;
    if (startedAt === undefined || startedAt === null || Number.isNaN(startedAt) || startedAt >= cutoff) continue;
    await rm(join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Removes `<stateDir>/tasks/<id>` (the per-task session dir) for tasks that no
 *  longer exist; a deleted task's dir would otherwise stay forever. Returns how many went. */
export async function sweepTaskState(db: DataSource, stateDir: string): Promise<number> {
  const tasksDir = join(stateDir, "tasks");
  let names: string[];
  try {
    names = await readdir(tasksDir);
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const alive = new Set(((await db.query("select id from tasks")) as { id: string }[]).map((r) => r.id));
  const orphans = names.filter((name) => !alive.has(name));
  await Promise.all(orphans.map((name) => rm(join(tasksDir, name), { recursive: true, force: true })));
  return orphans.length;
}

type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;
const RUNNER_REPOS = ["hardness-runner", "hardness-runner-qa"];

/** Untags `hardness-runner*:<sha>` images whose id differs from what that repository's `:dev`
 *  tag points at: every build leaves one behind, and they were 17 GB at last count. Returns
 *  the tags removed. */
export async function sweepImages(run: ExecFn = exec): Promise<string[]> {
  const listed = await run("docker", ["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"]);
  if (listed.code !== 0) return [];
  const images = listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([ref, id]) => ({ ref, id, repo: ref.slice(0, ref.lastIndexOf(":")), tag: ref.slice(ref.lastIndexOf(":") + 1) }));
  const removed: string[] = [];
  for (const repo of RUNNER_REPOS) {
    const current = images.find((i) => i.repo === repo && i.tag === "dev")?.id;
    if (!current) continue;
    for (const image of images) {
      if (image.repo !== repo || image.tag === "dev" || image.id === current) continue;
      if ((await run("docker", ["rmi", image.ref])).code === 0) removed.push(image.ref);
    }
  }
  return removed;
}
