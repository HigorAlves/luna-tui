import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureWorktree, workspaceFor } from "../adapters/git/worktree.ts";
import { TaskEntity } from "../adapters/persistence/schemas.ts";
import type { ExecResult } from "../adapters/process/exec.ts";
import { NO_RETRIES } from "../domain/transition.ts";
import { freshTestDatabase } from "../test/database.ts";
import { sweepImages, sweepRunFolders, sweepSlackTriageRuns, sweepTaskState, sweepWorktrees } from "./sweep.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sweep-")));
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function closedTask(repoPath: string, daysAgo: number, id = "11111111-2222-3333-4444-555555555555") {
  const workspace = workspaceFor({ id, title: "Fix it" }, repoPath, join(repoPath, "..", "wt"));
  await ensureWorktree(repoPath, workspace);
  const task = await db.getRepository(TaskEntity).save({
    title: "x", description: "", criteria: [], repoPath, branch: workspace.branch, worktreePath: workspace.path,
    state: "closed", retries: { ...NO_RETRIES }, resumeTo: null, reason: null,
  });
  await db.query("update tasks set updated_at = now() - make_interval(days => $2) where id = $1", [task.id, daysAgo]);
  return { task, workspace };
}

describe("sweepWorktrees", () => {
  it("removes the worktree and the merged branch of a task closed past the window, and forgets the path", async () => {
    const repoPath = repo();
    const { task, workspace } = await closedTask(repoPath, 10);
    const { task: recent, workspace: kept } = await closedTask(repoPath, 1, "22222222-2222-3333-4444-555555555555");

    const result = await sweepWorktrees(db, 7);

    expect(result).toEqual({ worktrees: 1, branches: 1 });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(repoPath, "branch", "--list", workspace.branch)).toBe("");
    expect((await db.getRepository(TaskEntity).findOneByOrFail({ id: task.id })).worktreePath).toBeNull();
    expect(existsSync(kept.path)).toBe(true);
    expect((await db.getRepository(TaskEntity).findOneByOrFail({ id: recent.id })).worktreePath).toBe(kept.path);
  });

  it("keeps a branch with unmerged commits, so nothing shipped only on the branch is lost", async () => {
    const repoPath = repo();
    const { workspace } = await closedTask(repoPath, 10);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    git(workspace.path, "add", "-A");
    git(workspace.path, "commit", "-q", "-m", "only here");

    expect(await sweepWorktrees(db, 7)).toEqual({ worktrees: 1, branches: 0 });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(repoPath, "branch", "--list", workspace.branch)).toContain(workspace.branch);
  });

  it("does nothing when the window is 0", async () => {
    const repoPath = repo();
    const { workspace } = await closedTask(repoPath, 10);
    expect(await sweepWorktrees(db, 0)).toEqual({ worktrees: 0, branches: 0 });
    expect(existsSync(workspace.path)).toBe(true);
  });
});

describe("sweepRunFolders", () => {
  it("removes run folders no stage run owns, keeps the rest", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    const task = await db.getRepository(TaskEntity).save({
      title: "x", description: "", criteria: [], repoPath: null, branch: null, worktreePath: null,
      state: "closed", retries: { ...NO_RETRIES }, resumeTo: null, reason: null,
    });
    const inserted = (await db.query(
      "insert into stage_runs (task_id, stage, attempt, status, started_at) values ($1, 'triage', 1, 'passed', now()) returning id",
      [task.id],
    )) as { id: string }[];
    const owned = inserted[0]!.id;
    mkdirSync(join(stateDir, "runs", owned), { recursive: true });
    mkdirSync(join(stateDir, "runs", "orphan-run"), { recursive: true });
    writeFileSync(join(stateDir, "runs", "orphan-run", "transcript.log"), "x");

    expect(await sweepRunFolders(db, stateDir)).toBe(1);
    expect(existsSync(join(stateDir, "runs", owned))).toBe(true);
    expect(existsSync(join(stateDir, "runs", "orphan-run"))).toBe(false);
    expect(await sweepRunFolders(db, join(stateDir, "nowhere"))).toBe(0);
  });
});

describe("sweepImages", () => {
  it("untags runner images superseded by the one :dev points at, per repository", async () => {
    const listing = [
      "hardness-runner:dev aaa111",
      "hardness-runner:0123456789ab aaa111",
      "hardness-runner:fedcba987654 bbb222",
      "hardness-runner-qa:dev ccc333",
      "hardness-runner-qa:111111111111 ddd444",
      "hardness-machine:local eee555",
    ].join("\n");
    const calls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push([command, ...args]);
      return { code: 0, stdout: args[0] === "images" ? `${listing}\n` : "", stderr: "" };
    });

    expect(await sweepImages(exec)).toEqual(["hardness-runner:fedcba987654", "hardness-runner-qa:111111111111"]);
    expect(calls).toContainEqual(["docker", "rmi", "hardness-runner:fedcba987654"]);
    expect(calls).toContainEqual(["docker", "rmi", "hardness-runner-qa:111111111111"]);
    expect(calls.some((c) => c[1] === "rmi" && /:dev$|0123456789ab|hardness-machine/.test(c[2] ?? ""))).toBe(false);
  });
});

describe("sweepTaskState", () => {
  it("removes per-task session dirs whose task is gone, keeps the rest", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    const task = await db.getRepository(TaskEntity).save({
      title: "x", description: "", criteria: [], repoPath: null, branch: null, worktreePath: null,
      state: "closed", retries: { ...NO_RETRIES }, resumeTo: null, reason: null,
    });
    mkdirSync(join(stateDir, "tasks", task.id, "session"), { recursive: true });
    mkdirSync(join(stateDir, "tasks", "11111111-2222-3333-4444-555555555555", "session"), { recursive: true });
    writeFileSync(join(stateDir, "tasks", "11111111-2222-3333-4444-555555555555", "session", "s.jsonl"), "{}");

    expect(await sweepTaskState(db, stateDir)).toBe(1);
    expect(existsSync(join(stateDir, "tasks", task.id))).toBe(true);
    expect(existsSync(join(stateDir, "tasks", "11111111-2222-3333-4444-555555555555"))).toBe(false);
    expect(await sweepTaskState(db, join(stateDir, "nowhere"))).toBe(0);
  });
});

describe("sweepSlackTriageRuns", () => {
  it("removes failed slack_triage run folders older than the window by their stamp, keeps the rest, and is off at 0", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "sweep-slack-"));
    const dir = join(stateDir, "slack-triage");
    for (const name of ["2026-07-01T12-00-00-000Z", "2026-07-01T12-00-00-000Z-2", "2026-10-27T09-30-00-000Z", "notes"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "t.log"), "x");
    }
    const now = new Date("2026-10-28T12:00:00Z");
    expect(await sweepSlackTriageRuns(stateDir, 0, now)).toBe(0);
    expect(await sweepSlackTriageRuns(stateDir, 90, now)).toBe(2);
    expect(existsSync(join(dir, "2026-07-01T12-00-00-000Z"))).toBe(false);
    expect(existsSync(join(dir, "2026-07-01T12-00-00-000Z-2"))).toBe(false);
    expect(existsSync(join(dir, "2026-10-27T09-30-00-000Z"))).toBe(true);
    // A folder with no stamp goes by its mtime: just written, so it stays.
    expect(existsSync(join(dir, "notes"))).toBe(true);
    expect(await sweepSlackTriageRuns(join(stateDir, "nowhere"), 90, now)).toBe(0);
  });
});
