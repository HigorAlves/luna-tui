import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pushBranch } from "../../application/stages/deliver.ts";
import { exec } from "../process/exec.ts";
import { ensureClone } from "./clone.ts";
import { at, machineGitDir } from "./machine-repo.ts";
import { HOST_GIT, commitAll, diffText, dirtyFiles, headCommit, workspaceFor } from "./worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

const task = { id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never;

async function card() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mrepo-")));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const workspace = workspaceFor(task, repo, join(root, "cards"));
  await ensureClone(repo, workspace);
  return { root, repo, remote, workspace };
}

/** What a steered agent leaves in the work folder: a `.git` whose commondir names a directory of its own, with a clean filter and an ssh command in its config. */
function plantHostileGit(path: string, markers: string): void {
  const evil = join(path, ".evil");
  execFileSync("git", ["init", "-q", "--bare", evil]);
  execFileSync("git", ["config", "--file", join(evil, "config"), "filter.x.clean", `touch ${join(markers, "filter")}; cat`]);
  execFileSync("git", ["config", "--file", join(evil, "config"), "core.sshCommand", `touch ${join(markers, "ssh")}; false`]);
  execFileSync("git", ["config", "--file", join(evil, "config"), "core.fsmonitor", `touch ${join(markers, "fsmonitor")}; echo`]);
  writeFileSync(join(path, ".gitattributes"), "* filter=x\n");
  rmSync(join(path, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-q", path]);
  writeFileSync(join(path, ".git", "commondir"), "../.evil\n");
  mkdirSync(join(path, ".git", "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "post-commit", "reference-transaction", "pre-push"]) {
    writeFileSync(join(path, ".git", "hooks", hook), `#!/bin/sh\ntouch ${join(markers, hook)}\n`, { mode: 0o755 });
  }
}

describe("a hostile .git in the work folder is data", () => {
  it("is exploitable by git run in the folder, which is why the host never does (the control)", async () => {
    const { workspace, root } = await card();
    const markers = join(root, "markers");
    mkdirSync(markers);
    plantHostileGit(workspace.path, markers);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    await exec("git", ["-C", workspace.path, "add", "-A"]);
    expect(existsSync(join(markers, "filter"))).toBe(true);
  });

  it("changes nothing the host does: add, commit, status, diff and a push behave as with a clean folder, and no marker appears", async () => {
    const { workspace, root, remote } = await card();
    const markers = join(root, "markers");
    mkdirSync(markers);
    plantHostileGit(workspace.path, markers);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const before = await headCommit(workspace.path);

    expect((await dirtyFiles(workspace.path)).some((l) => l.includes("b.txt"))).toBe(true);
    const sha = await commitAll(workspace.path, "feat: b");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await diffText(workspace.path, before, sha!)).toContain("+b");
    expect(await pushBranch(exec, workspace.branch, workspace.path)).toBeNull();
    expect(git(remote, "rev-parse", workspace.branch)).toBe(sha);
    expect(readdirSync(markers)).toEqual([]);

    // The container then replaces `.git` by a file naming the same directory.
    rmSync(join(workspace.path, ".git"), { recursive: true, force: true });
    writeFileSync(join(workspace.path, ".git"), "gitdir: ./.evil\n");
    writeFileSync(join(workspace.path, "c.txt"), "c\n");
    const second = await commitAll(workspace.path, "feat: c");
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    expect(await pushBranch(exec, workspace.branch, workspace.path)).toBeNull();
    expect(git(remote, "rev-parse", workspace.branch)).toBe(second);
    expect(readdirSync(markers)).toEqual([]);
  });

  it("refuses a workspace that has no repository of the machine's, rather than finding the folder's own", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mrepo-none-")));
    const folder = join(root, "w");
    mkdirSync(folder);
    execFileSync("git", ["init", "-q", folder]);
    writeFileSync(join(folder, "x.txt"), "x");
    const out = await exec("git", [...HOST_GIT, ...at(folder), "status", "--porcelain"]);
    expect(out.code).not.toBe(0);
    expect(existsSync(machineGitDir(folder))).toBe(false);
    await expect(headCommit(folder)).rejects.toThrow();
  });

  it("keeps the repository outside the folder, and the push settings out of it", async () => {
    const { workspace } = await card();
    const machine = machineGitDir(workspace.path);
    expect(machine.startsWith(workspace.path)).toBe(false);
    expect(existsSync(join(workspace.path, ".git"))).toBe(false);
    expect(git(machine, "config", "--local", "remote.origin.url")).toMatch(/remote\.git$/);
  });
});
