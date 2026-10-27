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
      { command: "git", args: ["-c", "core.hooksPath=/dev/null", "-C", "/repo", "worktree", "remove", "--force", path], cwd: undefined },
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
