// The host-side close step, run after a task reaches `closed`. It adds no task state: the
// pipeline stores the transition first, then calls this and logs the report. A failed step
// is reported, never thrown, because the task is already closed.
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExecResult } from "../sandbox/exec.ts";

export interface CloseStep {
  step: "orc-state" | "watch-tab" | "worktree";
  ok: boolean;
  note: string;
}

export interface CloseReport {
  steps: CloseStep[];
  /** True when the worktree was removed from disk, so the caller can clear its path. */
  worktreeRemoved: boolean;
}

export interface CloseDeps {
  exec: (command: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;
  /** Remove the worktree on close. Off by default: the board's `w` removes it on demand. */
  worktreeRemove: boolean;
  /** Path to `orc-state`, or null when it is not installed. */
  orcStateBin: string | null;
  watcher?: { close(taskId: string): Promise<void> };
}

export interface CloseTarget {
  id: string;
  repoPath: string | null;
  worktreePath: string | null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function attempt(step: CloseStep["step"], run: () => Promise<string>): Promise<CloseStep> {
  try {
    return { step, ok: true, note: await run() };
  } catch (error) {
    return { step, ok: false, note: message(error) };
  }
}

export async function closeTask(task: CloseTarget, deps: CloseDeps): Promise<CloseReport> {
  let worktreeRemoved = false;

  const orcState = await attempt("orc-state", async () => {
    if (!task.worktreePath) return "skipped: the task has no worktree";
    if (!deps.orcStateBin) return "skipped: orc-state is not installed";
    if (!existsSync(join(task.worktreePath, ".orc"))) return "skipped: no .orc in the worktree";
    const result = await deps.exec(deps.orcStateBin, ["close", "--merged"], { cwd: task.worktreePath });
    if (result.code !== 0) throw new Error(`orc-state close failed: ${(result.stderr || result.stdout).trim()}`);
    return "orc session marked completed";
  });

  const watchTab = await attempt("watch-tab", async () => {
    if (!deps.watcher) return "skipped: no watcher";
    await deps.watcher.close(task.id);
    return "watch tab closed";
  });

  const worktree = await attempt("worktree", async () => {
    if (!task.worktreePath || !task.repoPath) return "skipped: the task has no worktree";
    if (!deps.worktreeRemove) return "kept: remove it from the board with w";
    const result = await deps.exec("git", ["-C", task.repoPath, "worktree", "remove", "--force", task.worktreePath]);
    if (result.code !== 0) throw new Error(`git worktree remove failed: ${(result.stderr || result.stdout).trim()}`);
    worktreeRemoved = true;
    return "worktree removed";
  });

  return { steps: [orcState, watchTab, worktree], worktreeRemoved };
}
