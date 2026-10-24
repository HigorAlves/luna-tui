// Every call to the `gh` CLI, in one place. Delivering, shipping, CI watch and GitHub
// intake all go through this file instead of shelling out to `gh` themselves.
import { type ExecResult, exec } from "../process/exec.ts";
import { approvedPlan } from "../../domain/stage-input.ts";
import { buildPr } from "../../domain/prbody.ts";
import type { StageContext } from "../../application/ports.ts";

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number },
) => Promise<ExecResult>;

export interface GitDeps {
  exec: ExecFn;
}

export interface PrRef {
  url: string;
  number: number;
  isDraft: boolean;
}

/** A command's output, or a hint when it produced none (e.g. the binary is missing). */
export function describe(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text || `exit code ${result.code}; is \`gh\` installed and authenticated? (\`gh auth status\`)`;
}

/** The PR for this branch, or null when there is none. */
export async function findPr(deps: GitDeps, branch: string, cwd: string): Promise<PrRef | null> {
  const viewed = await deps.exec("gh", ["pr", "view", branch, "--json", "url,number,isDraft"], { cwd });
  if (viewed.code !== 0) return null;
  try {
    const parsed = JSON.parse(viewed.stdout) as Partial<PrRef>;
    if (typeof parsed.url !== "string" || typeof parsed.number !== "number") return null;
    return { url: parsed.url, number: parsed.number, isDraft: parsed.isDraft === true };
  } catch {
    return null;
  }
}

/** Opens a PR for the branch with the caveman body; the number comes from the URL gh prints. */
export async function openPr(
  deps: GitDeps,
  context: StageContext,
  options: { draft: boolean },
): Promise<{ ref: PrRef } | { error: string }> {
  const { task } = context;
  const branch = task.branch!;
  const cwd = task.worktreePath!;
  const repo = await deps.exec("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd });
  let repoSlug: string | null = null;
  if (repo.code === 0) {
    try {
      const name: unknown = JSON.parse(repo.stdout).nameWithOwner;
      repoSlug = typeof name === "string" ? name : null;
    } catch {
      // unknown repo: no `Closes` line
    }
  }
  const { title, body } = buildPr({ task, plan: approvedPlan(context.approvals), repoSlug });
  const created = await deps.exec(
    "gh",
    ["pr", "create", ...(options.draft ? ["--draft"] : []), "--title", title, "--body", body, "--head", branch],
    { cwd },
  );
  if (created.code !== 0) return { error: `gh pr create failed: ${describe(created)}` };
  const url = created.stdout.trim().split("\n").at(-1) ?? "";
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN);
  return { ref: { url, number, isDraft: options.draft } };
}

/** Pushes the task's branch from its worktree. Returns an error message on failure. */
export async function pushBranch(deps: GitDeps, branch: string, cwd: string): Promise<string | null> {
  const pushed = await deps.exec("git", ["-C", cwd, "push", "-u", "origin", branch]);
  return pushed.code === 0 ? null : `git push failed: ${describe(pushed)}`;
}

/** Marks a draft PR ready for review. */
export function markPrReady(deps: GitDeps, number: number, cwd: string): Promise<ExecResult> {
  return deps.exec("gh", ["pr", "ready", String(number)], { cwd });
}

/** The branch's PR checks, as `gh pr checks` reports them. */
export function prChecks(deps: GitDeps, branch: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
  return deps.exec("gh", ["pr", "checks", branch, "--json", "name,state,link"], { cwd, signal });
}

/** Re-runs a workflow run's failed jobs. */
export function rerunWorkflow(deps: GitDeps, runId: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
  return deps.exec("gh", ["run", "rerun", "--failed", runId], { cwd, signal });
}

export type Gh = (args: string[]) => Promise<ExecResult>;

/** The default `Gh`: runs the real `gh` binary on the host. */
export const defaultGh: Gh = (args) => exec("gh", args);

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
}

/** Open issues in `repo` labelled `label`. Throws with the raw `gh` error on failure. */
export async function listReadyIssues(gh: Gh, repo: string, label: string): Promise<GhIssue[]> {
  const result = await gh([
    "issue", "list", "--repo", repo, "--label", label, "--state", "open",
    "--json", "number,title,body,url", "--limit", "50",
  ]);
  if (result.code !== 0) throw new Error(`gh issue list failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as GhIssue[];
}
