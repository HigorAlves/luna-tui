import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { NoWorktreeError, parseNumstat, taskDiff } from "./diff.ts";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const failed: ExecResult = { code: 128, stdout: "", stderr: "fatal: not a git repository" };

/** A git whose answers are keyed by the subcommand and its arguments (after the host flags and `-C <dir>`). */
function fakeGit(answers: Record<string, ExecResult>) {
  const calls: string[] = [];
  const exec = async (_command: string, args: string[]) => {
    const dash = args.indexOf("-C");
    const key = args.slice(dash + 2).join(" ");
    calls.push(key);
    return answers[key] ?? { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  return { exec, calls };
}

const base = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const head = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

describe("taskDiff", () => {
  it("diffs the worktree's HEAD against its merge base with origin's default branch, one row per file", async () => {
    const git = fakeGit({
      "rev-parse HEAD": ok(`${head}\n`),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": ok("refs/remotes/origin/main\n"),
      [`merge-base HEAD origin/main`]: ok(`${base}\n`),
      [`diff -M --numstat ${base} HEAD`]: ok(`10\t2\tsrc/a.ts\n3\t0\tsrc/new.ts\n0\t7\tsrc/gone.ts\n1\t1\tsrc/{old => moved}.ts\n-\t-\tlogo.png\n`),
      [`diff -M --name-status ${base} HEAD`]: ok(`M\tsrc/a.ts\nA\tsrc/new.ts\nD\tsrc/gone.ts\nR090\tsrc/old.ts\tsrc/moved.ts\nA\tlogo.png\n`),
    });
    const diff = await taskDiff(git.exec, "/wt", "/repo");
    expect(diff).toEqual({
      base,
      head,
      files: [
        { path: "src/a.ts", status: "M", added: 10, removed: 2 },
        { path: "src/new.ts", status: "A", added: 3, removed: 0 },
        { path: "src/gone.ts", status: "D", added: 0, removed: 7 },
        { path: "src/moved.ts", status: "R", added: 1, removed: 1 },
        { path: "logo.png", status: "A", added: 0, removed: 0 },
      ],
    });
    expect(git.calls.every((c) => c.includes("HEAD") || c.startsWith("symbolic-ref") || c.startsWith("merge-base"))).toBe(true);
  });

  it("falls back to main, then to the repo's own HEAD, when origin has no default branch", async () => {
    const viaMain = fakeGit({
      "rev-parse HEAD": ok(head),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": failed,
      "rev-parse --verify --quiet main": ok("cccc"),
      "merge-base HEAD main": ok(base),
      [`diff -M --numstat ${base} HEAD`]: ok(""),
      [`diff -M --name-status ${base} HEAD`]: ok(""),
    });
    expect(await taskDiff(viaMain.exec, "/wt", "/repo")).toEqual({ base, head, files: [] });

    const viaRepo = fakeGit({
      "rev-parse HEAD": ok(head),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": failed,
      "rev-parse --verify --quiet main": failed,
      [`merge-base HEAD ${head}`]: ok(base),
      [`diff -M --numstat ${base} HEAD`]: ok(""),
      [`diff -M --name-status ${base} HEAD`]: ok(""),
    });
    // The repo's HEAD is read in the repo (-C /repo), everything else in the worktree.
    expect(await taskDiff(viaRepo.exec, "/wt", "/repo")).toEqual({ base, head, files: [] });
  });

  it("adds the one file's patch when asked for it", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const git = fakeGit({
      "rev-parse HEAD": ok(head),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": ok("refs/remotes/origin/main"),
      "merge-base HEAD origin/main": ok(base),
      [`diff -M --numstat ${base} HEAD`]: ok("1\t1\tsrc/a.ts\n"),
      [`diff -M --name-status ${base} HEAD`]: ok("M\tsrc/a.ts\n"),
      [`diff -M ${base} HEAD -- src/a.ts`]: ok(patch),
    });
    expect(await taskDiff(git.exec, "/wt", "/repo", "src/a.ts")).toMatchObject({ files: [{ path: "src/a.ts" }], patch });
  });

  it("says there is no worktree when the path is not a checkout anymore", async () => {
    const git = fakeGit({ "rev-parse HEAD": failed });
    await expect(taskDiff(git.exec, "/wt/gone", "/repo")).rejects.toThrow(NoWorktreeError);
  });
});

describe("parseNumstat", () => {
  it("reads binary files as zero lines and renames by their new path", () => {
    expect(parseNumstat("-\t-\ta.png\n2\t3\tdir/{a => b}/x.ts\n1\t0\told.ts => new.ts\n")).toEqual([
      { path: "a.png", added: 0, removed: 0 },
      { path: "dir/b/x.ts", added: 2, removed: 3 },
      { path: "new.ts", added: 1, removed: 0 },
    ]);
  });
});
