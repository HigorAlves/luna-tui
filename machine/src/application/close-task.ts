// The host-side close step, run after a task reaches `closed`. It adds no task state: the
// pipeline stores the transition first, then calls this and logs the report. A failed step
// is reported, never thrown, because the task is already closed.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HOST_GIT } from "../adapters/git/worktree.ts";
import type { ExecResult } from "../adapters/process/exec.ts";
import { CAP_BYTES, CAP_LINES, CONTEXT_FILE, mergeRules } from "./stages/memory.ts";

export interface CloseStep {
  step: "rules" | "orc-state" | "watch-tab" | "worktree";
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
  /** The memory review's proposal; `apply` is false when the approval said to skip it. */
  rules?: { markdown: string; apply: boolean };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Writes the approved rules into project-context.md and commits them on the task branch. */
async function applyRules(
  worktreePath: string | null,
  rules: { markdown: string; apply: boolean },
  deps: CloseDeps,
): Promise<string> {
  if (!rules.apply) return "skipped: approved without applying the rules";
  if (!worktreePath) return "skipped: the task has no worktree";
  const file = join(worktreePath, CONTEXT_FILE);
  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = null;
  }
  const merged = mergeRules(existing, rules.markdown);
  if (merged === existing) return "skipped: the file already holds these rules";
  const lines = merged.split("\n").length - 1;
  const bytes = Buffer.byteLength(merged);
  if (lines > CAP_LINES || bytes > CAP_BYTES) throw new Error(`cap exceeded: ${lines}/${bytes}`);

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, merged);
  const run = async (args: string[]): Promise<ExecResult> => deps.exec("git", [...HOST_GIT, "-C", worktreePath, ...args]);
  const added = await run(["add", CONTEXT_FILE]);
  if (added.code !== 0) throw new Error(`git add failed: ${(added.stderr || added.stdout).trim()}`);
  const committed = await run(["-c", "commit.gpgsign=false", "commit", "-m", "docs(context): rules from the memory review"]);
  if (committed.code !== 0) throw new Error(`git commit failed: ${(committed.stderr || committed.stdout).trim()}`);
  const upstream = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) return `committed ${CONTEXT_FILE} (${lines} lines); not pushed, no upstream`;
  const pushed = await run(["push"]);
  if (pushed.code !== 0) throw new Error(`committed, but git push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
  return `committed and pushed ${CONTEXT_FILE} (${lines} lines)`;
}

async function attempt(step: CloseStep["step"], run: () => Promise<string>): Promise<CloseStep> {
  try {
    return { step, ok: true, note: await run() };
  } catch (error) {
    return { step, ok: false, note: message(error) };
  }
}

export async function closeTask(task: CloseTarget, deps: CloseDeps): Promise<CloseReport> {
  let worktreeRemoved = false;

  const rules = task.rules
    ? await attempt("rules", () => applyRules(task.worktreePath, task.rules!, deps))
    : null;

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
    const result = await deps.exec("git", [...HOST_GIT, "-C", task.repoPath, "worktree", "remove", "--force", task.worktreePath]);
    if (result.code !== 0) throw new Error(`git worktree remove failed: ${(result.stderr || result.stdout).trim()}`);
    worktreeRemoved = true;
    return "worktree removed";
  });

  return { steps: [...(rules ? [rules] : []), orcState, watchTab, worktree], worktreeRemoved };
}
