// The delivering stage: push the task's branch and open a draft PR on the host, so CI starts
// early. Like shipping it needs only git and gh, not a Claude credential.
import { exec as realExec } from "../sandbox/exec.ts";
import type { ExecResult } from "../sandbox/exec.ts";
import { approvedPlan } from "./input.ts";
import { buildPr } from "./prbody.ts";
import type { StageContext, StageRunner } from "./runner.ts";

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

export function deliverRunner(deps: GitDeps): StageRunner {
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to deliver; the implementer never ran for real" } };
    }
    const pushError = await pushBranch(deps, task.branch, task.worktreePath);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };

    const existing = await findPr(deps, task.branch, task.worktreePath);
    const opened = existing ? { ref: existing } : await openPr(deps, context, { draft: true });
    if ("error" in opened) return { outcome: "fail", detail: { error: opened.error } };
    const { url, number } = opened.ref;
    return {
      outcome: "pass",
      detail: { prUrl: url, prNumber: number, draft: opened.ref.isDraft, reused: existing !== null },
      events: [{ at: new Date().toISOString(), kind: "pr.opened", payload: { url, number } }],
    };
  };
}

export const realDeliverRunner: StageRunner = deliverRunner({ exec: realExec });
