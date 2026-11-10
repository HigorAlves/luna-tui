import { HOST_GIT } from "../adapters/git/worktree.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExecResult } from "../adapters/process/exec.ts";
import { closeTask, type CloseDeps } from "./close-task.ts";

interface Call {
  command: string;
  args: string[];
  cwd?: string;
}

function fakeExec(result: Partial<ExecResult> | Error = {}) {
  const calls: Call[] = [];
  const exec: CloseDeps["exec"] = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (result instanceof Error) throw result;
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { calls, exec };
}

/** A worktree directory. */
function worktree(): string {
  return mkdtempSync(join(tmpdir(), "close-test-"));
}

const task = (worktreePath: string | null) => ({ id: "t1", repoPath: "/repo", worktreePath });

describe("closeTask: a card whose PR merged", () => {
  it("removes its workspace after the rules step even when removal is not switched on; any other close keeps it", async () => {
    const path = worktree();
    const merged = fakeExec();
    const report = await closeTask({ ...task(path), merged: { prUrl: "https://github.com/o/a/pull/7", number: 7 } }, { exec: merged.exec, worktreeRemove: false });
    expect(merged.calls).toEqual([{ command: "git", args: [...HOST_GIT, "-C", "/repo", "worktree", "remove", "--force", path], cwd: undefined }]);
    expect(report.worktreeRemoved).toBe(true);
    expect(report.steps.map((s) => s.step)).toEqual(["watch-tab", "worktree"]);
    const other = fakeExec();
    const kept = await closeTask(task(worktree()), { exec: other.exec, worktreeRemove: false });
    expect(other.calls).toEqual([]);
    expect(kept.worktreeRemoved).toBe(false);
  });
});

describe("closeTask", () => {
  it("closes the watch tab, and reports a failure to", async () => {
    const closed: string[] = [];
    const ok = await closeTask(task(null), {
      exec: fakeExec().exec,
      worktreeRemove: false,
      watcher: { close: async (id) => void closed.push(id) },
    });
    expect(closed).toEqual(["t1"]);
    expect(ok.steps.find((s) => s.step === "watch-tab")).toMatchObject({ ok: true });

    const bad = await closeTask(task(null), {
      exec: fakeExec().exec,
      worktreeRemove: false,
      watcher: { close: async () => Promise.reject(new Error("herdr down")) },
    });
    expect(bad.steps.find((s) => s.step === "watch-tab")).toMatchObject({ ok: false, note: "herdr down" });
  });

  it("keeps the worktree unless removal is switched on", async () => {
    const path = worktree();
    const kept = fakeExec();
    const report = await closeTask(task(path), { exec: kept.exec, worktreeRemove: false });
    expect(kept.calls).toEqual([]);
    expect(report.worktreeRemoved).toBe(false);
    expect(report.steps.find((s) => s.step === "worktree")).toMatchObject({ ok: true, note: expect.stringMatching(/kept/) });

    const removed = fakeExec();
    const second = await closeTask(task(path), { exec: removed.exec, worktreeRemove: true });
    expect(removed.calls).toEqual([
      { command: "git", args: [...HOST_GIT, "-C", "/repo", "worktree", "remove", "--force", path], cwd: undefined },
    ]);
    expect(second.worktreeRemoved).toBe(true);
  });
});

describe("closeTask rules step", () => {
  const rules = { markdown: "- Run pnpm verify before any commit.\n", apply: true };

  function recordingExec(upstream = true) {
    const calls: string[][] = [];
    const exec: CloseDeps["exec"] = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("rev-parse") && !upstream) return { code: 128, stdout: "", stderr: "no upstream" };
      return { code: 0, stdout: "origin/b\n", stderr: "" };
    };
    return { calls, exec };
  }

  it("writes project-context.md from the skeleton, commits it and pushes when there is an upstream", async () => {
    const { readFileSync } = await import("node:fs");
    const path = worktree();
    const { calls, exec } = recordingExec();
    const report = await closeTask({ ...task(path), rules }, { exec, worktreeRemove: false });

    const body = readFileSync(join(path, "docs/agents/project-context.md"), "utf8");
    expect(body).toContain("## Critical rules");
    expect(body).toContain("- Run pnpm verify before any commit.");
    expect(report.steps.map((s) => s.step)).toEqual(["rules", "watch-tab", "worktree"]);
    expect(report.steps[0]).toMatchObject({ step: "rules", ok: true });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("add docs/agents/project-context.md"))).toBe(true);
    expect(flat.some((c) => c.includes("commit.gpgsign=false") && c.includes("docs(context): rules from the memory review"))).toBe(true);
    expect(flat.some((c) => c.endsWith("push"))).toBe(true);
  });

  it("does not push without an upstream", async () => {
    const { calls, exec } = recordingExec(false);
    await closeTask({ ...task(worktree()), rules }, { exec, worktreeRemove: false });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("refuses when the result would exceed the cap and writes nothing", async () => {
    const { existsSync } = await import("node:fs");
    const path = worktree();
    const { calls, exec } = recordingExec();
    const big = { markdown: Array.from({ length: 200 }, (_, i) => `- rule ${i}`).join("\n"), apply: true };
    const report = await closeTask({ ...task(path), rules: big }, { exec, worktreeRemove: false });

    expect(report.steps[0]).toMatchObject({ step: "rules", ok: false, note: expect.stringMatching(/^cap exceeded: \d+\/\d+/) });
    expect(existsSync(join(path, "docs/agents/project-context.md"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("skips the step when applyRules is false", async () => {
    const { calls, exec } = recordingExec();
    const report = await closeTask(
      { ...task(worktree()), rules: { ...rules, apply: false } },
      { exec, worktreeRemove: false },
    );
    expect(report.steps[0]).toMatchObject({ step: "rules", ok: true, note: expect.stringMatching(/^skipped/) });
    expect(calls).toEqual([]);
  });

  it("appends under Critical rules in an existing file", async () => {
    const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const path = worktree();
    mkdirSync(join(path, "docs/agents"), { recursive: true });
    writeFileSync(join(path, "docs/agents/project-context.md"), "# Project context\n\n## Critical rules\n\n- Old.\n\n## Conventions\n\n- Keep.\n");
    const { exec } = recordingExec();
    await closeTask({ ...task(path), rules }, { exec, worktreeRemove: false });
    const body = readFileSync(join(path, "docs/agents/project-context.md"), "utf8");
    expect(body.indexOf("- Run pnpm verify")).toBeGreaterThan(body.indexOf("- Old."));
    expect(body.indexOf("- Run pnpm verify")).toBeLessThan(body.indexOf("## Conventions"));
  });
});

describe("closeTask: promoted facts", () => {
  const promotions = [{ id: "aaaaaaaaaaaa", text: "Run the tests with `python -m pytest -q`.", section: "Commands" }, { id: "bbbbbbbbbbbb", text: "Generated clients live in `src/gen/`.", section: "Known landmines" }];
  const exec: CloseDeps["exec"] = async (_c, args) => (args.includes("rev-parse") ? { code: 128, stdout: "", stderr: "no upstream" } : { code: 0, stdout: "", stderr: "" });

  it("merges each fact's own text into its section beside the rules, and reports the ids as promoted", async () => {
    const { readFileSync } = await import("node:fs");
    const path = worktree();
    const report = await closeTask({ ...task(path), rules: { markdown: "- Run pnpm verify.\n", apply: true, factPromotions: promotions } }, { exec, worktreeRemove: false });
    const body = readFileSync(join(path, "docs/agents/project-context.md"), "utf8");
    expect(body).toContain("## Commands\n\n- Run the tests with `python -m pytest -q`.");
    expect(body).toContain("## Known landmines\n\n- Generated clients live in `src/gen/`.");
    expect(body).toContain("- Run pnpm verify.");
    expect(report.promoted).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("writes the facts when the retro proposed no rules at all", async () => {
    const { readFileSync } = await import("node:fs");
    const path = worktree();
    const report = await closeTask({ ...task(path), rules: { markdown: "", apply: true, factPromotions: promotions } }, { exec, worktreeRemove: false });
    expect(readFileSync(join(path, "docs/agents/project-context.md"), "utf8")).toContain("- Generated clients live in `src/gen/`.");
    expect(report.promoted).toHaveLength(2);
  });

  it("reports them promoted when the file already holds their text, and not when the step was skipped or failed", async () => {
    const path = worktree();
    await closeTask({ ...task(path), rules: { markdown: "", apply: true, factPromotions: promotions } }, { exec, worktreeRemove: false });
    const again = await closeTask({ ...task(path), rules: { markdown: "", apply: true, factPromotions: promotions } }, { exec, worktreeRemove: false });
    expect(again.steps[0]!.note).toMatch(/^skipped: the file already holds/);
    expect(again.promoted).toHaveLength(2);
    const declined = await closeTask({ ...task(worktree()), rules: { markdown: "", apply: false, factPromotions: promotions } }, { exec, worktreeRemove: false });
    expect(declined.promoted).toBeUndefined();
    const big = Array.from({ length: 200 }, (_, i) => `- rule ${i}`).join("\n");
    const failed = await closeTask({ ...task(worktree()), rules: { markdown: big, apply: true, factPromotions: promotions } }, { exec, worktreeRemove: false });
    expect(failed.steps[0]!.ok).toBe(false);
    expect(failed.promoted).toBeUndefined();
  });
});

describe("closeTask after a merge: the rules go to their own branch and a draft PR", () => {
  const rules = { markdown: "- Run pnpm verify before any commit. @bob #12\n", apply: true };
  const target = (path: string) => ({ id: "0a1b2c3d-1111-2222-3333-444455556666", title: "Export CSV", repoPath: "/repo", worktreePath: path, rules, merged: { prUrl: "https://github.com/o/a/pull/7", number: 7 } });

  function wire(over: { push?: number; defaultBranch?: string | null } = {}) {
    const calls: string[][] = [];
    const exec: CloseDeps["exec"] = async (_c, args) => {
      const a = args.slice(args.indexOf("-C") + 2).filter((a) => !a.startsWith("--git-dir=") && !a.startsWith("--work-tree="));
      calls.push(a);
      return { code: a[0] === "push" ? (over.push ?? 0) : 0, stdout: "", stderr: over.push ? "denied" : "" };
    };
    const opened: unknown[][] = [];
    const github = { openPr: async (slug: string, pr: unknown) => (opened.push([slug, pr]), { url: "https://github.com/o/a/pull/9", number: 9, isDraft: true }) };
    const deps: CloseDeps = { exec, worktreeRemove: false, github, slugOf: async () => "o/a", defaultBranchOf: async () => (over.defaultBranch === undefined ? "main" : over.defaultBranch) };
    return { calls, opened, deps };
  }

  it("branches from origin's default branch, commits, pushes with -u and opens a draft PR that links the task's PR", async () => {
    const { readFileSync } = await import("node:fs");
    const path = worktree();
    const { calls, opened, deps } = wire();
    const report = await closeTask(target(path), deps);
    expect(report.steps[0]).toMatchObject({ step: "rules", ok: true, note: expect.stringContaining("luna/memory-0a1b2c3d") });
    expect(report.steps[0]!.note).toContain("https://github.com/o/a/pull/9");
    expect(calls.map((c) => c.join(" "))).toEqual([
      "fetch --quiet --end-of-options origin main",
      "checkout -B luna/memory-0a1b2c3d origin/main",
      "add docs/agents/project-context.md",
      "-c commit.gpgsign=false commit -m docs(context): rules from the memory review",
      "push -u origin luna/memory-0a1b2c3d",
      // the rules step is first; the merged card's workspace is removed after it
      `worktree remove --force ${path}`,
    ]);
    expect(readFileSync(join(path, "docs/agents/project-context.md"), "utf8")).toContain("- Run pnpm verify before any commit.");
    expect(opened).toHaveLength(1);
    const [slug, pr] = opened[0] as [string, { title: string; body: string; head: string; draft: boolean }];
    expect(slug).toBe("o/a");
    expect(pr).toMatchObject({ title: "docs(agents): rules from Export CSV", head: "luna/memory-0a1b2c3d", draft: true });
    expect(pr.body).toContain("https://github.com/o/a/pull/7");
    expect(pr.body).not.toMatch(/@bob|#12/);
  });

  it("never touches the merged branch, and says so when the push or the default branch is unusable", async () => {
    const refused = wire({ push: 1 });
    expect((await closeTask(target(worktree()), refused.deps)).steps[0]).toMatchObject({ ok: false, note: expect.stringContaining("git push failed") });
    expect(refused.opened).toEqual([]);
    const odd = wire({ defaultBranch: "--upload-pack=x" });
    expect((await closeTask(target(worktree()), odd.deps)).steps[0]).toMatchObject({ ok: false, note: expect.stringContaining("default branch") });
    // nothing of the rules step ran: only the merged card's workspace removal did
    expect(odd.calls.map((c) => c[0])).toEqual(["worktree"]);
  });
});

describe("closeTask: the rules file is only ever a real file inside the worktree", () => {
  const rules = { markdown: "- Run pnpm verify before any commit.\n", apply: true };

  async function withLink(where: "file" | "docs" | "agents") {
    const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
    const path = worktree();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "target.md"), "secret\n");
    if (where === "docs") symlinkSync(outside, join(path, "docs"));
    else {
      mkdirSync(join(path, "docs"), { recursive: true });
      if (where === "agents") symlinkSync(outside, join(path, "docs/agents"));
      else {
        mkdirSync(join(path, "docs/agents"), { recursive: true });
        symlinkSync(join(outside, "target.md"), join(path, "docs/agents/project-context.md"));
      }
    }
    return { path, outside };
  }

  function wire() {
    const calls: string[][] = [];
    const exec: CloseDeps["exec"] = async (_c, args) => (calls.push(args.slice(args.indexOf("-C") + 2).filter((a) => !a.startsWith("--git-dir=") && !a.startsWith("--work-tree="))), { code: 0, stdout: "", stderr: "" });
    const github = { openPr: async () => ({ url: "https://github.com/o/a/pull/9", number: 9, isDraft: true }) };
    const deps: CloseDeps = { exec, worktreeRemove: false, github, slugOf: async () => "o/a", defaultBranchOf: async () => "main" };
    return { calls, deps };
  }

  for (const where of ["file", "docs", "agents"] as const) {
    it(`refuses a symlink at ${where}, before a merge and after one, and writes nothing outside`, async () => {
      const { readFileSync, readdirSync } = await import("node:fs");
      for (const merged of [null, { prUrl: "https://github.com/o/a/pull/7", number: 7 }]) {
        const { path, outside } = await withLink(where);
        const { calls, deps } = wire();
        const report = await closeTask({ id: "0a1b2c3d-1111", title: "t", repoPath: "/repo", worktreePath: path, rules, merged }, deps);
        expect(report.steps[0]).toMatchObject({ step: "rules", ok: false, note: expect.stringContaining("symlink") });
        expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("secret\n");
        expect(readdirSync(outside)).toEqual(["target.md"]);
        expect(calls.some((c) => c[0] === "add" || c[0] === "commit" || c[0] === "push")).toBe(false);
      }
    });
  }

  it("keeps the merged PR's own address clickable and breaks an address inside the rules", async () => {
    const opened: Array<{ body: string }> = [];
    const exec: CloseDeps["exec"] = async () => ({ code: 0, stdout: "", stderr: "" });
    const deps: CloseDeps = { exec, worktreeRemove: false, github: { openPr: async (_s, pr) => (opened.push(pr), { url: "u", number: 9, isDraft: true }) }, slugOf: async () => "o/a", defaultBranchOf: async () => "main" };
    await closeTask({ id: "0a1b2c3d-1111", title: "t", repoPath: "/repo", worktreePath: worktree(), rules: { markdown: "- see https://evil.example/a and www.evil.example/b and [x](https://evil.example/c)\n", apply: true }, merged: { prUrl: "https://github.com/o/a/pull/7", number: 7 } }, deps);
    expect(opened[0]!.body).toContain(": https://github.com/o/a/pull/7\n");
    expect(opened[0]!.body.replace("https://github.com/o/a/pull/7", "")).not.toMatch(/https?:\/\/|\bwww\.|\]\(/i);
  });

  it("escapes HTML and redacts a token in the draft PR's body", async () => {
    // Built at run time: a literal of this shape blocks the push.
    const token = "gh" + "p_" + "d".repeat(24);
    const opened: Array<{ body: string }> = [];
    const calls: string[][] = [];
    const exec: CloseDeps["exec"] = async (_c, args) => (calls.push(args), { code: 0, stdout: "", stderr: "" });
    const deps: CloseDeps = { exec, worktreeRemove: false, github: { openPr: async (_s, pr) => (opened.push(pr), { url: "u", number: 9, isDraft: true }) }, slugOf: async () => "o/a", defaultBranchOf: async () => "main" };
    await closeTask({ id: "0a1b2c3d-1111", title: "t", repoPath: "/repo", worktreePath: worktree(), rules: { markdown: `- a <!-- hidden --> <details>x\n- ${token}\n`, apply: true }, merged: { prUrl: "https://github.com/o/a/pull/7", number: 7 } }, deps);
    expect(opened[0]!.body).not.toMatch(/<!--|<details>|ghp_/);
    expect(opened[0]!.body).toContain("&lt;!-- hidden --&gt;");
    expect(opened[0]!.body).toContain("[redacted]");
  });
});

describe("closing a card whose workspace is a clone", () => {
  it("removes a clone with nothing unpushed, folder and repository, and keeps one with commits the machine has not pushed, saying so", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { exec } = await import("../adapters/process/exec.ts");
    const { ensureClone } = await import("../adapters/git/clone.ts");
    const { machineGitDir } = await import("../adapters/git/machine-repo.ts");
    const { commitAll, workspaceFor } = await import("../adapters/git/worktree.ts");
    const root = worktree();
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "cards"));
    await ensureClone(repo, workspace);
    const closed = await closeTask({ id: "t1", repoPath: repo, worktreePath: workspace.path }, { exec, worktreeRemove: true });
    expect(closed.worktreeRemoved).toBe(true);
    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(machineGitDir(workspace.path))).toBe(false);

    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b");
    await commitAll(workspace.path, "work");
    const kept = await closeTask({ id: "t1", repoPath: repo, worktreePath: workspace.path }, { exec, worktreeRemove: true });
    expect(kept.worktreeRemoved).toBe(false);
    expect(existsSync(workspace.path)).toBe(true);
    expect(kept.steps.find((s) => s.step === "worktree")).toMatchObject({ ok: true, note: expect.stringMatching(/unpushed/) });
  });
});
