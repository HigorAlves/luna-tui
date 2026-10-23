import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExecResult } from "../sandbox/exec.ts";
import { closeTask, type CloseDeps } from "./close.ts";

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

/** A worktree directory, with or without orc's `.orc/` state inside. */
function worktree(withOrc: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "close-test-"));
  if (withOrc) mkdirSync(join(dir, ".orc"));
  return dir;
}

const task = (worktreePath: string | null) => ({ id: "t1", repoPath: "/repo", worktreePath });

describe("closeTask", () => {
  it("marks orc's session merged from inside the worktree", async () => {
    const path = worktree(true);
    const { calls, exec } = fakeExec();
    const report = await closeTask(task(path), { exec, worktreeRemove: false, orcStateBin: "/bin/orc-state" });

    expect(calls).toEqual([{ command: "/bin/orc-state", args: ["close", "--merged"], cwd: path }]);
    expect(report.steps).toContainEqual({ step: "orc-state", ok: true, note: expect.any(String) });
  });

  it("skips orc-state when the worktree has no .orc", async () => {
    const { calls, exec } = fakeExec();
    const report = await closeTask(task(worktree(false)), {
      exec,
      worktreeRemove: false,
      orcStateBin: "/bin/orc-state",
    });

    expect(calls).toEqual([]);
    expect(report.steps.find((s) => s.step === "orc-state")).toMatchObject({ ok: true, note: expect.stringMatching(/skipped.*\.orc/) });
  });

  it("skips orc-state when the binary is not installed", async () => {
    const { calls, exec } = fakeExec();
    const report = await closeTask(task(worktree(true)), { exec, worktreeRemove: false, orcStateBin: null });

    expect(calls).toEqual([]);
    expect(report.steps.find((s) => s.step === "orc-state")).toMatchObject({ ok: true, note: expect.stringMatching(/skipped.*orc-state/) });
  });

  it("reports a throwing or failing command and still resolves", async () => {
    const path = worktree(true);
    const thrown = await closeTask(task(path), {
      exec: fakeExec(new Error("boom")).exec,
      worktreeRemove: false,
      orcStateBin: "/bin/orc-state",
    });
    expect(thrown.steps.find((s) => s.step === "orc-state")).toMatchObject({ ok: false, note: "boom" });

    const failed = await closeTask(task(path), {
      exec: fakeExec({ code: 2, stderr: "no session" }).exec,
      worktreeRemove: false,
      orcStateBin: "/bin/orc-state",
    });
    expect(failed.steps.find((s) => s.step === "orc-state")).toMatchObject({ ok: false, note: expect.stringContaining("no session") });
  });

  it("closes the watch tab, and reports a failure to", async () => {
    const closed: string[] = [];
    const ok = await closeTask(task(null), {
      exec: fakeExec().exec,
      worktreeRemove: false,
      orcStateBin: null,
      watcher: { close: async (id) => void closed.push(id) },
    });
    expect(closed).toEqual(["t1"]);
    expect(ok.steps.find((s) => s.step === "watch-tab")).toMatchObject({ ok: true });

    const bad = await closeTask(task(null), {
      exec: fakeExec().exec,
      worktreeRemove: false,
      orcStateBin: null,
      watcher: { close: async () => Promise.reject(new Error("herdr down")) },
    });
    expect(bad.steps.find((s) => s.step === "watch-tab")).toMatchObject({ ok: false, note: "herdr down" });
  });

  it("keeps the worktree unless removal is switched on", async () => {
    const path = worktree(false);
    const kept = fakeExec();
    const report = await closeTask(task(path), { exec: kept.exec, worktreeRemove: false, orcStateBin: null });
    expect(kept.calls).toEqual([]);
    expect(report.worktreeRemoved).toBe(false);
    expect(report.steps.find((s) => s.step === "worktree")).toMatchObject({ ok: true, note: expect.stringMatching(/kept/) });

    const removed = fakeExec();
    const second = await closeTask(task(path), { exec: removed.exec, worktreeRemove: true, orcStateBin: null });
    expect(removed.calls).toEqual([
      { command: "git", args: ["-C", "/repo", "worktree", "remove", "--force", path], cwd: undefined },
    ]);
    expect(second.worktreeRemoved).toBe(true);
  });
});
