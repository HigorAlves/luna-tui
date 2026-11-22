// The ui-designer helper's git (RFC 0013, phase 5): real repositories in a temp dir, as clone.test.ts has them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { advanceBranch } from "./bundles.ts";
import { ensureClone } from "./clone.ts";
import { MAX_HELPER_COMMITS, gitVersionProblem, landInWorktree, helperRef, helperWorkspace, pickBundle, pickOnto, pickedRef, takeHelperCommits } from "./helper.ts";
import { machineGitDir } from "./machine-repo.ts";
import { workspaceFor } from "./worktree.ts";

const base = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...base, ...args], { encoding: "utf8" }).trim();
/** git on a workspace, the way the host runs it. */
const wgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...base, ...args], { encoding: "utf8" }).trim();
const mgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), ...base, ...args], { encoding: "utf8" }).trim();

const task = { id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never;
const TASK = "11111111-2222-3333-4444-555555555555";
const machine = { name: "Luna Machine", email: "machine@luna.test" };
const trailer = "Luna-Helper: ui-designer, slice 3";

/** Writes files in a workspace and commits them; answers the commit. */
function commit(path: string, files: Record<string, string>, message: string, env: Record<string, string> = {}): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), text);
  }
  execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...base, "add", "-A"], { env: { ...process.env, ...env } });
  execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...base, "commit", "-q", "-m", message], { env: { ...process.env, ...env } });
  return wgit(path, "rev-parse", "HEAD");
}

/** A card at P (a tests commit on top of the repository's one), and a helper workspace made at B = P. */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "helper-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), "one\ntwo\nthree\nfour\nfive\n");
  writeFileSync(join(repo, "src", "api.ts"), "api\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const workspace = workspaceFor(task, repo, join(root, "cards"));
  await ensureClone(repo, workspace);
  const card = workspace.path;
  const tests = commit(card, { "src/card.test.ts": "test\n" }, "test: the card's tests");
  const made = await helperWorkspace.make(card, tests, TASK, 3, 1);
  return { root, card, branch: workspace.branch, tests, helper: made.path, made };
}

describe("helperWorkspace", () => {
  it("makes <card>.helper-<slice>-<attempt> at the base, on luna-helper-<slice>, and records the helper ref at the base in the card's repository", async () => {
    const f = await fixture();
    expect(f.helper).toBe(`${f.card}.helper-3-1`);
    expect(f.made.branch).toBe("luna-helper-3");
    expect(wgit(f.helper, "rev-parse", "HEAD")).toBe(f.tests);
    expect(wgit(f.helper, "rev-parse", "--abbrev-ref", "HEAD")).toBe("luna-helper-3");
    expect(mgit(f.card, "rev-parse", helperRef(TASK, 3))).toBe(f.tests);
    expect(helperRef(TASK, 3)).toBe(`refs/luna/helper/${TASK}/3`);
    expect(pickedRef(TASK, 3)).toBe(`refs/luna/helper/${TASK}/3-picked`);
    for (const ref of [helperRef(TASK, 3), pickedRef(TASK, 3)]) execFileSync("git", ["check-ref-format", ref]);
  });

  it("refuses a base that is not a commit id and a slice or task that would not make a safe ref", async () => {
    const f = await fixture();
    await expect(helperWorkspace.make(f.card, "main", TASK, 3, 2)).rejects.toThrow();
    await expect(helperWorkspace.make(f.card, f.tests, "../x", 3, 2)).rejects.toThrow();
    await expect(helperWorkspace.make(f.card, f.tests, TASK, 0, 2)).rejects.toThrow();
  });
});

describe("takeHelperCommits", () => {
  it("fetches the helper's branch into the card's repository, oldest first, and moves the helper ref to its tip", async () => {
    const f = await fixture();
    const one = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat(ui): card");
    const two = commit(f.helper, { "src/ui/Card.css": "css\n" }, "feat(ui): card css");
    const taken = await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    expect(taken).toEqual({ ok: true, tip: two, commits: [one, two] });
    expect(mgit(f.card, "rev-parse", helperRef(TASK, 3))).toBe(two);
    // The card's own branch is untouched, and the temporary fetch ref is gone.
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(f.tests);
    expect(mgit(f.card, "for-each-ref", "refs/luna/helper-in")).toBe("");
  });

  it("returns no commits when the helper made none", async () => {
    const f = await fixture();
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests)).toEqual({ ok: true, tip: f.tests, commits: [] });
  });

  it("refuses a merge commit in base..tip", async () => {
    const f = await fixture();
    commit(f.helper, { "src/ui/a.tsx": "a\n" }, "feat: a");
    wgit(f.helper, "checkout", "-q", "-b", "side", f.tests);
    commit(f.helper, { "src/ui/b.tsx": "b\n" }, "feat: b");
    wgit(f.helper, "checkout", "-q", "luna-helper-3");
    wgit(f.helper, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const taken = await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    expect(taken).toMatchObject({ ok: false, reason: "merge_commit" });
    // A refusal leaves the helper ref where it was.
    expect(mgit(f.card, "rev-parse", helperRef(TASK, 3))).toBe(f.tests);
  });

  it("refuses a gitlink, even one a later commit removes", async () => {
    const f = await fixture();
    wgit(f.helper, "update-index", "--add", "--cacheinfo", `160000,${f.tests},vendor/x`);
    wgit(f.helper, "commit", "-q", "-m", "feat: nested");
    wgit(f.helper, "rm", "-q", "--cached", "vendor/x");
    wgit(f.helper, "commit", "-q", "-m", "feat: nested gone");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests)).toMatchObject({ ok: false, reason: "gitlink" });
  });

  it("refuses a tip that does not descend from the base", async () => {
    const f = await fixture();
    commit(f.helper, { "src/ui/a.tsx": "a\n" }, "feat: a");
    // A foreign history: a root commit with no parent.
    const tree = wgit(f.helper, "hash-object", "-t", "tree", "-w", "--stdin");
    const root = wgit(f.helper, "commit-tree", tree, "-m", "foreign");
    wgit(f.helper, "update-ref", "refs/heads/luna-helper-3", root);
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests)).toMatchObject({ ok: false, reason: "not_descendant" });
  });

  it("refuses more than the cap of commits", async () => {
    const f = await fixture();
    for (let i = 0; i <= MAX_HELPER_COMMITS; i++) commit(f.helper, { [`src/ui/f${i}.tsx`]: `${i}\n` }, `feat: ${i}`);
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests)).toMatchObject({ ok: false, reason: "too_many" });
  });

  it("refuses a commit that touches a file the implementer holds, a rename away from one included, and names the files", async () => {
    const f = await fixture();
    commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat: card");
    commit(f.helper, { "src/index.ts": "changed\n" }, "feat: touches the implementer's file");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests, { locked: ["src/index.ts", "src/api/"] })).toEqual(expect.objectContaining({ ok: false, reason: "locked_file", files: ["src/index.ts"] }));
    const g = await fixture();
    mkdirSync(join(g.helper, "src/ui"), { recursive: true });
    wgit(g.helper, "mv", "src/api.ts", "src/ui/api.ts");
    wgit(g.helper, "commit", "-q", "-m", "feat: moved a locked file");
    expect(await takeHelperCommits(g.card, g.helper, TASK, 3, g.tests, { locked: ["src/api.ts"] })).toMatchObject({ ok: false, reason: "locked_file", files: ["src/api.ts"] });
  });

  it("never runs a hook the helper's repository holds", async () => {
    const f = await fixture();
    commit(f.helper, { "src/ui/a.tsx": "a\n" }, "feat: a");
    const marker = join(f.root, "hook-ran");
    for (const name of ["post-checkout", "reference-transaction", "pre-auto-gc", "post-update", "pre-upload-pack"]) {
      mkdirSync(join(machineGitDir(f.helper), "hooks"), { recursive: true });
      writeFileSync(join(machineGitDir(f.helper), "hooks", name), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    execFileSync("git", ["--git-dir=" + machineGitDir(f.helper), "config", "core.fsmonitor", `touch ${marker}`]);
    execFileSync("git", ["--git-dir=" + machineGitDir(f.helper), "config", "uploadpack.packObjectsHook", `touch ${marker}`]);
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests)).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("answers a refusal, never a throw, when the helper's repository has no branch", async () => {
    const f = await fixture();
    wgit(f.helper, "branch", "-m", "luna-helper-3", "other");
    wgit(f.helper, "symbolic-ref", "HEAD", "refs/heads/other");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests)).toMatchObject({ ok: false, reason: "no_branch" });
  });
});

/** Takes the helper's commits into the card's repository, as the coordinator does before a pick. */
async function take(f: { card: string; helper: string; tests: string }): Promise<void> {
  const taken = await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
  if (!taken.ok) throw new Error(`not taken: ${taken.reason}`);
}

describe("pickOnto", () => {
  it("cherry-picks each commit onto the tip by plumbing: the same trees, the original author and date, the machine as committer, the trailer; no branch, index or folder moves", async () => {
    const f = await fixture();
    const when = "2024-05-06T07:08:09Z";
    const env = { GIT_AUTHOR_NAME: "Helper", GIT_AUTHOR_EMAIL: "helper@x.test", GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: "Helper", GIT_COMMITTER_EMAIL: "helper@x.test" };
    const one = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat(ui): card\n\nthe body", env);
    const two = commit(f.helper, { "src/ui/Card.css": "css\n" }, "feat(ui): css", env);
    const filesBefore = readdirSync(f.card).sort();
    const indexBefore = mgit(f.card, "ls-files", "--stage");
    const taken = await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    if (!taken.ok) throw new Error("not taken");
    const picked = await pickOnto(f.card, f.tests, taken.commits, machine, trailer, { task: TASK, slice: 3 });
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.picked).toHaveLength(2);
    expect(picked.tip).toBe(picked.picked[1]);
    expect(picked.picked).not.toContain(one);
    // Same tree as the helper's, one parent at a time, on the tests commit.
    expect(mgit(f.card, "rev-parse", `${picked.picked[1]}^{tree}`)).toBe(mgit(f.card, "rev-parse", `${two}^{tree}`));
    expect(mgit(f.card, "rev-parse", `${picked.picked[0]}^`)).toBe(f.tests);
    expect(mgit(f.card, "rev-parse", `${picked.picked[1]}^`)).toBe(picked.picked[0]);
    const meta = mgit(f.card, "log", "-1", "--format=%an|%ae|%aI|%cn|%ce", picked.picked[0]!);
    expect(meta).toBe(`Helper|helper@x.test|${when}|Luna Machine|machine@luna.test`);
    const body = mgit(f.card, "log", "-1", "--format=%B", picked.picked[0]!);
    expect(body).toBe(`feat(ui): card\n\nthe body\n\n(cherry picked from commit ${one})\n${trailer}`);
    // The tests commit is an ancestor of the new tip.
    expect(execFileSync("git", ["--git-dir=" + machineGitDir(f.card), "merge-base", "--is-ancestor", f.tests, picked.tip]).length).toBe(0);
    // The picked tip is recorded; nothing else moved.
    expect(mgit(f.card, "rev-parse", pickedRef(TASK, 3))).toBe(picked.tip);
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(f.tests);
    expect(readdirSync(f.card).sort()).toEqual(filesBefore);
    expect(mgit(f.card, "ls-files", "--stage")).toBe(indexBefore);
  });

  it("picks cleanly onto a tip the implementer has moved on from the base, when the files differ", async () => {
    const f = await fixture();
    const one = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat(ui): card");
    // The implementer works on in the card's folder: another file, a new commit P2.
    const p2 = commit(f.card, { "src/server.ts": "server\n" }, "feat: server");
    await take(f);
    const picked = await pickOnto(f.card, p2, [one], machine, trailer, { task: TASK, slice: 3 });
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(mgit(f.card, "ls-tree", "-r", "--name-only", picked.tip).split("\n")).toEqual(expect.arrayContaining(["src/server.ts", "src/ui/Card.tsx", "src/card.test.ts"]));
    expect(mgit(f.card, "rev-parse", `${picked.tip}^`)).toBe(p2);
  });

  it("answers a conflict, never a throw, naming the files, and leaves no ref behind", async () => {
    const f = await fixture();
    const one = commit(f.helper, { "src/index.ts": "one\nTWO helper\nthree\nfour\nfive\n" }, "feat: helper edit");
    const p2 = commit(f.card, { "src/index.ts": "one\nTWO card\nthree\nfour\nfive\n" }, "feat: card edit");
    await take(f);
    const refs = mgit(f.card, "for-each-ref");
    const picked = await pickOnto(f.card, p2, [one], machine, trailer, { task: TASK, slice: 3 });
    expect(picked).toEqual({ ok: false, conflict: true, files: ["src/index.ts"] });
    expect(mgit(f.card, "for-each-ref")).toBe(refs);
  });

  it("stops at the first conflicting commit and leaves nothing of the earlier picks behind", async () => {
    const f = await fixture();
    const one = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat: ok");
    const two = commit(f.helper, { "src/index.ts": "one\nTWO helper\nthree\nfour\nfive\n" }, "feat: clash");
    const p2 = commit(f.card, { "src/index.ts": "one\nTWO card\nthree\nfour\nfive\n" }, "feat: card edit");
    await take(f);
    const picked = await pickOnto(f.card, p2, [one, two], machine, trailer, { task: TASK, slice: 3 });
    expect(picked).toMatchObject({ ok: false, conflict: true, files: ["src/index.ts"] });
    expect(mgit(f.card, "for-each-ref", pickedRef(TASK, 3))).toBe("");
  });

  it("refuses an onto or a commit that is not a commit id", async () => {
    const f = await fixture();
    expect(await pickOnto(f.card, "main", [], machine, trailer, { task: TASK, slice: 3 })).toMatchObject({ ok: false, conflict: false });
    expect(await pickOnto(f.card, f.tests, ["--output=x"], machine, trailer, { task: TASK, slice: 3 })).toMatchObject({ ok: false, conflict: false });
  });
});

describe("takeHelperCommits: the slice's own files only", () => {
  const allowed = ["src/ui/Card.tsx", "src/ui/Card.test.tsx"];

  it("accepts the planned files and a new file beside one", async () => {
    const f = await fixture();
    commit(f.helper, { "src/ui/Card.tsx": "card\n", "src/ui/Card.css": "css\n" }, "feat(ui): card");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests, { allowed })).toMatchObject({ ok: true });
  });

  it("refuses a modified manifest, even when the slice names it", async () => {
    const f = await fixture();
    commit(f.card, { "package.json": "{}\n" }, "chore: manifest");
    const g = await helperWorkspace.make(f.card, mgit(f.card, "rev-parse", `refs/heads/${f.branch}`), TASK, 3, 2);
    commit(g.path, { "package.json": '{"scripts":{"postinstall":"x"}}\n' }, "feat: post");
    expect(await takeHelperCommits(f.card, g.path, TASK, 3, mgit(f.card, "rev-parse", `refs/heads/${f.branch}`), { allowed: [...allowed, "package.json"] })).toMatchObject({ ok: false, reason: "out_of_slice", files: ["package.json"] });
  });

  it("refuses a new workflow file under .github, even beside a planned one", async () => {
    const f = await fixture();
    commit(f.helper, { ".github/workflows/x.yml": "on: push\n" }, "ci: x");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests, { allowed: [...allowed, ".github/workflows/y.yml"] })).toMatchObject({ ok: false, reason: "out_of_slice", files: [".github/workflows/x.yml"] });
  });

  it("refuses a modified file no slice planned (even beside a planned one: only a new file passes) and a new file elsewhere", async () => {
    const f = await fixture();
    commit(f.helper, { "src/index.ts": "changed\n", "src/other/New.tsx": "n\n" }, "feat: more");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests, { allowed })).toMatchObject({ ok: false, reason: "out_of_slice", files: ["src/index.ts", "src/other/New.tsx"] });
    const h = await helperWorkspace.make(f.card, f.tests, TASK, 3, 3);
    commit(h.path, { "src/index.ts": "changed\n" }, "feat: beside");
    expect(await takeHelperCommits(f.card, h.path, TASK, 3, f.tests, { allowed: [...allowed, "src/card.test.ts"] })).toMatchObject({ ok: false, reason: "out_of_slice", files: ["src/index.ts"] });
    const g = await helperWorkspace.make(f.card, f.tests, TASK, 3, 2);
    commit(g.path, { "src/ui/Card.tsx": "card\n" }, "feat: card");
    commit(g.path, { "src/ui/Card.tsx": "card\n", "src/ui/Other.tsx": "o\n" }, "feat: other");
    expect(await takeHelperCommits(f.card, g.path, TASK, 3, f.tests, { allowed })).toMatchObject({ ok: true });
  });

  it("refuses a protected test path (the tests commit's files), planned or not", async () => {
    const f = await fixture();
    commit(f.helper, { "src/card.test.ts": "weaker\n" }, "test: weaker");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests, { allowed: [...allowed, "src/card.test.ts"], protectedPaths: ["src/card.test.ts"] })).toMatchObject({ ok: false, reason: "out_of_slice", files: ["src/card.test.ts"] });
  });

  it("names a non-ASCII path as it is", async () => {
    const f = await fixture();
    commit(f.helper, { "src/ui/Botão.tsx": "b\n", "lib/Ação.ts": "a\n" }, "feat: b");
    expect(await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests, { allowed })).toMatchObject({ ok: false, reason: "out_of_slice", files: ["lib/Ação.ts"] });
  });
});

describe("advanceBranch", () => {
  it("moves the branch from one commit to another by compare-and-swap and puts the index in step", async () => {
    const f = await fixture();
    const p2 = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat: card");
    await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    expect(await advanceBranch(f.card, f.branch, f.tests, p2)).toEqual({ ok: true });
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(p2);
    expect(mgit(f.card, "ls-files")).toContain("src/ui/Card.tsx");
  });

  it("refuses with `moved` when the branch is no longer at from, and changes nothing", async () => {
    const f = await fixture();
    const p2 = commit(f.card, { "src/server.ts": "s\n" }, "feat: server");
    const other = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat: card");
    await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    expect(await advanceBranch(f.card, f.branch, f.tests, other)).toEqual({ ok: false, reason: "moved" });
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(p2);
  });
});

describe("advanceBranch: only forward", () => {
  it("refuses a `to` that is an ancestor of from or a sibling of it, and the branch stays", async () => {
    const f = await fixture();
    const sibling = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat: card");
    await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    const p2 = commit(f.card, { "src/server.ts": "s\n" }, "feat: server");
    // An ancestor (the card's earlier commit) is a step back, a sibling (the helper's own line) is no descendant.
    expect(await advanceBranch(f.card, f.branch, p2, f.tests)).toEqual({ ok: false, reason: "invalid" });
    expect(await advanceBranch(f.card, f.branch, p2, sibling)).toEqual({ ok: false, reason: "invalid" });
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(p2);
  });
});

describe("landInWorktree", () => {
  /** The card at P, the picked tip T on the branch (the index at T, as advanceBranch leaves it) and the folder still at P. */
  async function landed(files: Record<string, string>) {
    const f = await fixture();
    const one = commit(f.helper, files, "feat: card");
    await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    const picked = await pickOnto(f.card, f.tests, [one], machine, trailer, { task: TASK, slice: 3 });
    if (!picked.ok) throw new Error("not picked");
    expect(await advanceBranch(f.card, f.branch, f.tests, picked.tip)).toEqual({ ok: true });
    return { f, tip: picked.tip };
  }

  it("brings the folder to the picked tip: new and changed files appear, other local edits stay", async () => {
    const { f, tip } = await landed({ "src/ui/Card.tsx": "card\n", "src/api.ts": "api2\n" });
    writeFileSync(join(f.card, "src/index.ts"), "my edit\n");
    expect(existsSync(join(f.card, "src/ui/Card.tsx"))).toBe(false);
    expect(await landInWorktree(f.card, f.tests, tip)).toEqual({ ok: true });
    expect(readFileSync(join(f.card, "src/ui/Card.tsx"), "utf8")).toBe("card\n");
    expect(readFileSync(join(f.card, "src/api.ts"), "utf8")).toBe("api2\n");
    expect(readFileSync(join(f.card, "src/index.ts"), "utf8")).toBe("my edit\n");
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(tip);
  });

  it("refuses, naming the files, when local edits sit on a file the pick changes, and leaves the folder as it was", async () => {
    const { f, tip } = await landed({ "src/api.ts": "api2\n" });
    writeFileSync(join(f.card, "src/api.ts"), "my edit\n");
    expect(await landInWorktree(f.card, f.tests, tip)).toEqual({ ok: false, files: ["src/api.ts"] });
    expect(readFileSync(join(f.card, "src/api.ts"), "utf8")).toBe("my edit\n");
    expect(mgit(f.card, "rev-parse", `refs/heads/${f.branch}`)).toBe(tip);
  });

  it("refuses a from or to that is not a commit id", async () => {
    const f = await fixture();
    expect(await landInWorktree(f.card, "HEAD", f.tests)).toMatchObject({ ok: false });
  });
});

describe("pickBundle", () => {
  it("writes a bundle of the picked tip over `from` through a temporary name, and the bundle fetches into a clone at from", async () => {
    const f = await fixture();
    const one = commit(f.helper, { "src/ui/Card.tsx": "card\n" }, "feat: card");
    await takeHelperCommits(f.card, f.helper, TASK, 3, f.tests);
    const picked = await pickOnto(f.card, f.tests, [one], machine, trailer, { task: TASK, slice: 3 });
    if (!picked.ok) throw new Error("not picked");
    const dest = join(f.root, "mailbox", "pick-1.bundle");
    mkdirSync(join(f.root, "mailbox"));
    expect(await pickBundle(f.card, f.tests, pickedRef(TASK, 3), dest)).toEqual({ ok: true });
    expect(readdirSync(join(f.root, "mailbox"))).toEqual(["pick-1.bundle"]);
    expect(readFileSync(dest).subarray(0, 16).toString()).toMatch(/^# v\d git bundle/);
    // A container holding the card at `from` can fetch the tip from it.
    const other = join(f.root, "other");
    execFileSync("git", ["init", "-q", "-b", "main", other]);
    execFileSync("git", ["-C", other, "fetch", "-q", machineGitDir(f.card), `refs/heads/${f.branch}:refs/heads/at-from`]);
    execFileSync("git", ["-C", other, "fetch", "-q", dest, `${pickedRef(TASK, 3)}:refs/heads/picked`]);
    expect(git(other, "rev-parse", "picked")).toBe(picked.tip);
  });

  it("answers a refusal for an empty range and leaves no file", async () => {
    const f = await fixture();
    mkdirSync(join(f.root, "mailbox"));
    mgit(f.card, "update-ref", pickedRef(TASK, 3), f.tests);
    const result = await pickBundle(f.card, f.tests, pickedRef(TASK, 3), join(f.root, "mailbox", "pick-1.bundle"));
    expect(result.ok).toBe(false);
    expect(readdirSync(join(f.root, "mailbox"))).toEqual([]);
  });
});

describe("gitVersionProblem", () => {
  it.each([
    ["git version 2.47.3", null],
    ["git version 2.40.0", null],
    ["git version 2.56.1.windows.1", null],
    ["git version 3.0.0", null],
    ["git version 2.39.5", expect.stringContaining("2.40")],
    ["git version 1.9.0", expect.stringContaining("2.40")],
    ["fatal: not git", expect.stringContaining("2.40")],
  ])("reads %s", (text, expected) => {
    expect(gitVersionProblem(text)).toEqual(expected);
  });
});
