import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClone } from "../adapters/git/clone.ts";
import { machineGitDir } from "../adapters/git/machine-repo.ts";
import { workspaceFor } from "../adapters/git/worktree.ts";
import { expireKept, keepFolder, saveKept } from "./kept-sandboxes.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["--git-dir=" + machineGitDir(cwd), "--work-tree=" + cwd, "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

const plain = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

async function card() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kept-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  plain(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  plain(repo, "add", "-A");
  plain(repo, "commit", "-q", "-m", "init");
  const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "cards"));
  await ensureClone(repo, workspace);
  return { root, stateDir: join(root, "state"), path: workspace.path };
}

const HOUR = 3_600_000;
const NOW = new Date("2026-11-05T12:00:00Z");

describe("saving what an escalated run left", () => {
  it("commits the uncommitted and untracked work on refs/luna/kept/<run> and leaves the tree, the index and HEAD exactly as they were", async () => {
    const { path, stateDir } = await card();
    writeFileSync(join(path, "a.txt"), "edited\n");
    writeFileSync(join(path, "new.txt"), "untracked\n");
    git(path, "add", "a.txt");
    writeFileSync(join(path, "a.txt"), "edited again\n");
    const before = { head: git(path, "rev-parse", "HEAD"), status: git(path, "status", "--porcelain"), staged: git(path, "diff", "--cached") };
    const out = await saveKept({ stateDir, taskId: "t1", runId: "run-1", path, keepHours: 24, now: NOW });
    expect(out).toEqual({ ok: true, ref: "refs/luna/kept/run-1", path, until: new Date(NOW.getTime() + 24 * HOUR).toISOString() });
    expect({ head: git(path, "rev-parse", "HEAD"), status: git(path, "status", "--porcelain"), staged: git(path, "diff", "--cached") }).toEqual(before);
    expect(git(path, "show", "refs/luna/kept/run-1:a.txt")).toBe("edited again");
    expect(git(path, "show", "refs/luna/kept/run-1:new.txt")).toBe("untracked");
    expect(git(path, "rev-parse", "refs/luna/kept/run-1^")).toBe(before.head);
  });

  it("refuses a run id that is not a plain name", async () => {
    const { path, stateDir } = await card();
    expect(await saveKept({ stateDir, taskId: "t1", runId: "../x", path, keepHours: 24, now: NOW })).toMatchObject({ ok: false });
  });
});

describe("a kept sandbox's extra folders", () => {
  const extra = async () => {
    const c = await card();
    const folder = `${c.path}.verify-run-1`;
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "x.txt"), "x");
    await keepFolder({ stateDir: c.stateDir, taskId: "t1", runId: "run-1", path: folder, now: NOW });
    return { ...c, folder };
  };

  it("lasts keep_hours: still there before, removed after; the clone and the kept ref stay", async () => {
    const { path, stateDir, folder } = await extra();
    await saveKept({ stateDir, taskId: "t1", runId: "run-1", path, keepHours: 24, now: NOW });
    expect(await expireKept({ stateDir, keepHours: 24, now: new Date(NOW.getTime() + 23 * HOUR) })).toEqual([]);
    expect(existsSync(folder)).toBe(true);
    expect(await expireKept({ stateDir, keepHours: 24, now: new Date(NOW.getTime() + 25 * HOUR) })).toEqual([folder]);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(git(path, "rev-parse", "--verify", "refs/luna/kept/run-1")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is removed at once when the card is resumed or closed", async () => {
    const { stateDir, folder } = await extra();
    expect(await expireKept({ stateDir, keepHours: 24, now: NOW, taskId: "other" })).toEqual([]);
    expect(await expireKept({ stateDir, keepHours: 24, now: NOW, taskId: "t1" })).toEqual([folder]);
    expect(existsSync(folder)).toBe(false);
  });

  it("never removes a folder that is not a verify or fix clone", async () => {
    const { stateDir, root } = await card();
    const precious = join(root, "precious");
    mkdirSync(precious);
    await keepFolder({ stateDir, taskId: "t1", runId: "run-9", path: precious, now: NOW });
    expect(await expireKept({ stateDir, keepHours: 1, now: new Date(NOW.getTime() + 5 * HOUR) })).toEqual([]);
    expect(existsSync(precious)).toBe(true);
  });
});
