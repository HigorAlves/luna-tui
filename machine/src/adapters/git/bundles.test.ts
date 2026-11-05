import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bundleImporter } from "./bundles.ts";
import { ensureClone, refreshScratch } from "./clone.ts";
import { machineGitDir } from "./machine-repo.ts";
import { commitAll, dirtyFiles, workspaceFor } from "./worktree.ts";

const base = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const plain = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...base, ...args], { encoding: "utf8" }).trim();
const host = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...base, ...args], { encoding: "utf8" }).trim();

const task = { id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never;

/** A card with the agent's scratch repository, and a place for its bundles; `agentCommit` is what the container does. */
async function card() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bundles-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  plain(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  plain(repo, "add", "-A");
  plain(repo, "commit", "-q", "-m", "init");
  const workspace = workspaceFor(task, repo, join(root, "cards"));
  await ensureClone(repo, workspace);
  await refreshScratch(workspace.path, workspace.branch);
  const out = join(root, "out", "bundles");
  mkdirSync(out, { recursive: true });
  const start = plain(workspace.path, "rev-parse", "HEAD");
  let n = 0;
  const agentCommit = (name: string, content = `${name}\n`) => {
    writeFileSync(join(workspace.path, name), content);
    plain(workspace.path, "add", "-A");
    plain(workspace.path, "commit", "-q", "-m", name);
    const file = join(out, `${++n}.bundle`);
    plain(workspace.path, "bundle", "create", file, `${start}..HEAD`);
    return { file, tip: plain(workspace.path, "rev-parse", "HEAD") };
  };
  const importer = () => bundleImporter({ path: workspace.path, branch: workspace.branch, runId: "run-1", dir: out });
  return { root, repo, workspace, out, start, agentCommit, importer };
}

describe("importing what a run committed", () => {
  it("moves the card's branch to the bundle's tip as a fast-forward, with the index in step, so the folder equals the tip", async () => {
    const { workspace, agentCommit, importer } = await card();
    const { tip } = agentCommit("b.txt");
    expect(await importer().sync()).toEqual({ ok: true, head: tip, changed: true });
    expect(host(workspace.path, "rev-parse", "refs/heads/" + workspace.branch)).toBe(tip);
    expect(host(workspace.path, "rev-parse", "refs/luna/in/run-1")).toBe(tip);
    expect(await dirtyFiles(workspace.path)).toEqual([]);
  });

  it("reads the newest bundle, imports each only once, and says nothing changed when there is no bundle", async () => {
    const { agentCommit, importer, start } = await card();
    const imp = importer();
    expect(await imp.sync()).toMatchObject({ ok: true, head: start, changed: false });
    agentCommit("b.txt");
    expect(await imp.sync()).toMatchObject({ ok: true, changed: true });
    expect(await imp.sync()).toMatchObject({ ok: true, changed: false });
    const second = agentCommit("c.txt");
    expect(await imp.sync()).toEqual({ ok: true, head: second.tip, changed: true });
  });

  it("refuses a bundle that does not descend from the card's branch as head_moved, and moves nothing", async () => {
    const { workspace, agentCommit, importer } = await card();
    agentCommit("b.txt");
    // The machine committed on the card in the meantime (the tests step does): the run's history no longer descends from it.
    writeFileSync(join(workspace.path, "machine.txt"), "m\n");
    const moved = await commitAll(workspace.path, "test: the machine's own");
    const out = await importer().sync();
    expect(out).toMatchObject({ ok: false, kind: "head_moved" });
    expect(host(workspace.path, "rev-parse", "refs/heads/" + workspace.branch)).toBe(moved);
  });

  it("fails a truncated bundle", async () => {
    const { agentCommit, importer, workspace } = await card();
    const { file } = agentCommit("b.txt");
    truncateSync(file, 40);
    const before = host(workspace.path, "rev-parse", "refs/heads/" + workspace.branch);
    expect(await importer().sync()).toMatchObject({ ok: false, kind: "bad_bundle" });
    expect(host(workspace.path, "rev-parse", "refs/heads/" + workspace.branch)).toBe(before);
  });

  it("fails a bundle that is a symlink, and one that is too big, and a bundles folder that is a symlink", async () => {
    const { agentCommit, importer, out, root } = await card();
    const { file } = agentCommit("b.txt");
    const real = join(root, "elsewhere.bundle");
    execFileSync("mv", [file, real]);
    symlinkSync(real, file);
    expect(await importer().sync()).toMatchObject({ ok: false, kind: "bad_bundle" });
    execFileSync("rm", [file]);
    execFileSync("mv", [real, file]);
    const big = bundleImporter({ path: join(root, "cards", "repo", "task-11111111-fix-it"), branch: "task/11111111-fix-it", runId: "run-1", dir: out, maxBytes: 10 });
    expect(await big.sync()).toMatchObject({ ok: false, kind: "bad_bundle" });
    const linked = join(root, "linked");
    symlinkSync(join(root, "out", "bundles"), linked);
    const viaLink = bundleImporter({ path: join(root, "cards", "repo", "task-11111111-fix-it"), branch: "task/11111111-fix-it", runId: "run-1", dir: linked });
    expect(await viaLink.sync()).toMatchObject({ ok: false, kind: "bad_bundle" });
  });

  it("ignores a name that is not <n>.bundle, and a bundle with a ref it was not asked for", async () => {
    const { agentCommit, importer, out, workspace } = await card();
    agentCommit("b.txt");
    writeFileSync(join(out, "evil.bundle"), "junk");
    writeFileSync(join(out, "../notes.txt"), "x");
    expect(await importer().sync()).toMatchObject({ ok: true, changed: true });
    expect(existsSync(join(out, "evil.bundle"))).toBe(true);
    expect(host(workspace.path, "for-each-ref", "--format=%(refname)").split("\n").filter((r) => r.startsWith("refs/heads/"))).toEqual(["refs/heads/" + workspace.branch]);
  });

  it("makes no host git run in the agent's repository: a hostile .git next to the bundle changes nothing", async () => {
    const { workspace, agentCommit, importer, root } = await card();
    const marker = join(root, "marker");
    const { tip } = agentCommit("b.txt");
    execFileSync("git", ["config", "--file", join(workspace.path, ".git", "config"), "core.fsmonitor", `touch ${marker}; echo`]);
    writeFileSync(join(workspace.path, ".git", "commondir"), "../nowhere\n");
    expect(await importer().sync()).toEqual({ ok: true, head: tip, changed: true });
    expect(existsSync(marker)).toBe(false);
  });
});
