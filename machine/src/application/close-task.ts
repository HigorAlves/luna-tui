// The host-side close step, run after a task reaches `closed`. It adds no task state: the
// pipeline stores the transition first, then calls this and logs the report. A failed step
// is reported, never thrown, because the task is already closed.
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redact } from "../domain/evidence-markdown.ts";
import { isClone, unpushedCommits } from "../adapters/git/clone.ts";
import { at } from "../adapters/git/machine-repo.ts";
import { HOST_GIT, defaultBranch as hostDefaultBranch, isBranchName, originSlugOf, removeWorktree } from "../adapters/git/worktree.ts";
import type { ExecResult } from "../adapters/process/exec.ts";
import type { GitHub } from "./github.ts";
import { CAP_BYTES, CAP_LINES, CONTEXT_FILE, mergeRules } from "./stages/memory.ts";

export interface CloseStep {
  step: "rules" | "watch-tab" | "worktree";
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
  watcher?: { close(taskId: string): Promise<void> };
  /** Opens the draft PR the rules of a merged task go in. */
  github?: Pick<GitHub, "openPr">;
  /** The `owner/name` of a worktree (default: its origin); tests inject one. */
  slugOf?: (cwd: string) => Promise<string | null>;
  /** The repo's default branch (default: read from the repo); tests inject one. */
  defaultBranchOf?: (repoPath: string) => Promise<string | null>;
}

export interface CloseTarget {
  id: string;
  repoPath: string | null;
  worktreePath: string | null;
  /** The memory review's proposal; `apply` is false when the approval said to skip it. */
  rules?: { markdown: string; apply: boolean };
  title?: string;
  /** The task's PR, when it merged: the rules then go to their own branch, never the merged one. */
  merged?: { prUrl: string; number: number } | null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The rules file's path, after checking that neither `docs`, `docs/agents` nor the file is a symlink (a stage can leave one, and the host would write through it, outside the worktree) or anything but a regular file. */
async function checkedRulesFile(worktreePath: string): Promise<string> {
  for (const rel of ["docs", "docs/agents", CONTEXT_FILE]) {
    const info = await lstat(join(worktreePath, rel)).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`${rel} is a symlink: the rules are not written`);
    if (info && rel === CONTEXT_FILE && !info.isFile()) throw new Error(`${rel} is not a regular file: the rules are not written`);
  }
  return join(worktreePath, CONTEXT_FILE);
}

/** After the folder exists: it must really be `docs/agents` inside the worktree. */
async function requireInside(worktreePath: string, file: string): Promise<void> {
  if ((await realpath(dirname(file))) !== join(await realpath(worktreePath), "docs", "agents")) throw new Error("docs/agents is not inside the worktree: the rules are not written");
}

/** Writes the approved rules into project-context.md and commits them on the task branch. */
async function applyRules(
  target: CloseTarget,
  rules: { markdown: string; apply: boolean },
  deps: CloseDeps,
): Promise<string> {
  const { worktreePath } = target;
  if (!rules.apply) return "skipped: approved without applying the rules";
  if (!worktreePath) return "skipped: the task has no worktree";
  if (target.merged) return applyRulesOnBranch(target, worktreePath, rules, deps);
  const file = await checkedRulesFile(worktreePath);
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
  await requireInside(worktreePath, file);
  await writeFile(file, merged);
  const run = async (args: string[]): Promise<ExecResult> => deps.exec("git", [...HOST_GIT, ...at(worktreePath), ...args]);
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

/** A model's text for a draft PR's body: tokens redacted, HTML escaped (a `<!--` or `<details>` would hide the rest from the reviewer), mentions and issue references neutralized: a draft PR must not ping anyone or close anything. */
const inert = (text: string): string => redact(text).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@(?=[A-Za-z0-9])/g, "@\u200b").replace(/#(?=\d)/g, "#\u200b");

/** After a merge the task's branch is gone: the rules go on `luna/memory-<task8>`, cut from origin's default branch, pushed with -u and opened as a draft PR. The branch name is the machine's, never from a model. */
async function applyRulesOnBranch(target: CloseTarget, worktreePath: string, rules: { markdown: string }, deps: CloseDeps): Promise<string> {
  const base = await (deps.defaultBranchOf ?? hostDefaultBranch)(target.repoPath ?? worktreePath);
  if (!base || !isBranchName(base)) throw new Error(`no usable default branch: ${JSON.stringify(base ?? null)}`);
  const short = target.id.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "task";
  const branch = `luna/memory-${short}`;
  const slug = await (deps.slugOf ?? originSlugOf)(worktreePath);
  if (!deps.github || !slug) throw new Error("cannot open the rules PR: no GitHub token or origin");
  const run = async (args: string[]): Promise<ExecResult> => deps.exec("git", [...HOST_GIT, ...at(worktreePath), ...args]);
  const must = async (what: string, args: string[]) => {
    const out = await run(args);
    if (out.code !== 0) throw new Error(`git ${what} failed: ${(out.stderr || out.stdout).trim()}`);
  };
  await must("fetch", ["fetch", "--quiet", "--end-of-options", "origin", base]);
  await must("checkout", ["checkout", "-B", branch, `origin/${base}`]);
  // The file as the default branch has it now, not as the merged branch left it.
  const file = await checkedRulesFile(worktreePath);
  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = null;
  }
  const merged = mergeRules(existing, rules.markdown);
  if (merged === existing) return "skipped: the file already holds these rules";
  const lines = merged.split("\n").length - 1;
  if (lines > CAP_LINES || Buffer.byteLength(merged) > CAP_BYTES) throw new Error(`cap exceeded: ${lines}/${Buffer.byteLength(merged)}`);
  await mkdir(dirname(file), { recursive: true });
  await requireInside(worktreePath, file);
  await writeFile(file, merged);
  await must("add", ["add", CONTEXT_FILE]);
  await must("commit", ["-c", "commit.gpgsign=false", "commit", "-m", "docs(context): rules from the memory review"]);
  await must("push", ["push", "-u", "origin", branch]);
  const title = `docs(agents): rules from ${(target.title ?? "the task").replace(/\s+/g, " ").trim().slice(0, 100)}`;
  const body = `Rules proposed by the retro of the task whose PR merged: ${target.merged!.prUrl}\n\n${inert(rules.markdown).slice(0, 20_000)}`;
  const pr = await deps.github.openPr(slug, { title, body, head: branch, draft: true });
  return `committed ${CONTEXT_FILE} (${lines} lines) on ${branch}, pushed, and opened the draft PR ${pr.url}`;
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
    ? await attempt("rules", () => applyRules(task, task.rules!, deps))
    : null;

  const watchTab = await attempt("watch-tab", async () => {
    if (!deps.watcher) return "skipped: no watcher";
    await deps.watcher.close(task.id);
    return "watch tab closed";
  });

  const worktree = await attempt("worktree", async () => {
    if (!task.worktreePath || !task.repoPath) return "skipped: the task has no worktree";
    if (!deps.worktreeRemove) return "kept: remove it from the board with w";
    if (isClone(task.worktreePath)) {
      const unpushed = await unpushedCommits(task.worktreePath);
      if (unpushed.length > 0) return `kept: the clone holds ${unpushed.length} unpushed commit(s); push them, or remove it from the board`;
      await removeWorktree(task.repoPath, task.worktreePath);
      worktreeRemoved = true;
      return "workspace removed";
    }
    const result = await deps.exec("git", [...HOST_GIT, "-C", task.repoPath, "worktree", "remove", "--force", task.worktreePath]);
    if (result.code !== 0) throw new Error(`git worktree remove failed: ${(result.stderr || result.stdout).trim()}`);
    worktreeRemoved = true;
    return "worktree removed";
  });

  return { steps: [...(rules ? [rules] : []), watchTab, worktree], worktreeRemoved };
}
