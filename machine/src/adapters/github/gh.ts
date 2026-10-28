// Every call to the `gh` CLI, in one place. Delivering, shipping, CI watch and GitHub
// intake all go through this file instead of shelling out to `gh` themselves.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewContext, ThreadsContext } from "@hardness/contracts";

import { PR_QUERY, type PrNode } from "../../domain/pull-request.ts";
import { HOST_GIT } from "../git/worktree.ts";
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
  const pushed = await deps.exec("git", [...HOST_GIT, "-C", cwd, "push", "-u", "origin", branch]);
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

/** The failed steps' log of one workflow run, as `gh run view --log-failed` prints it. */
export function failedRunLog(deps: GitDeps, runId: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
  return deps.exec("gh", ["run", "view", runId, "--log-failed"], { cwd, signal });
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

// ---- The PR inbox: what the poller reads and what the host writes back for a PR task ----

export interface PrSearchHit {
  repo: string;
  number: number;
  updatedAt: string;
}

const SEARCH_JSON = "number,repository,updatedAt";

/** Every open PR you authored or were asked to review, deduped, in search order. */
export async function searchMyPrs(gh: Gh): Promise<PrSearchHit[]> {
  const seen = new Set<string>();
  const hits: PrSearchHit[] = [];
  for (const filter of ["--review-requested=@me", "--author=@me"]) {
    const result = await gh(["search", "prs", filter, "--state=open", "--json", SEARCH_JSON, "--limit", "100"]);
    if (result.code !== 0) throw new Error(`gh search prs failed: ${describe(result)}`);
    const rows = JSON.parse(result.stdout) as Array<{ number: number; repository: { nameWithOwner: string }; updatedAt: string }>;
    for (const row of rows) {
      const repo = row.repository.nameWithOwner;
      const key = `${repo}#${row.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ repo, number: row.number, updatedAt: row.updatedAt });
    }
  }
  return hits;
}

const splitSlug = (repo: string): [string, string] => {
  const [owner = "", name = ""] = repo.split("/");
  return [owner, name];
};

/** `gh api graphql` with `-f`/`-F` variables; answers the parsed `data`, or throws with gh's words. */
async function graphql(gh: Gh, query: string, vars: Record<string, string | number>): Promise<Record<string, unknown>> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(vars)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  const result = await gh(args);
  if (result.code !== 0) throw new Error(`gh api graphql failed: ${describe(result)}`);
  const parsed = JSON.parse(result.stdout) as { data?: Record<string, unknown> };
  return parsed.data ?? {};
}

/** The PR's node for `PR_QUERY`, or null when GitHub no longer shows it. */
export async function prFacts(gh: Gh, repo: string, number: number): Promise<PrNode | null> {
  const [owner, name] = splitSlug(repo);
  const data = await graphql(gh, PR_QUERY, { owner, name, number });
  const repository = data.repository as { pullRequest: PrNode | null } | null | undefined;
  return repository?.pullRequest ?? null;
}

export async function viewerLogin(gh: Gh): Promise<string> {
  const data = await graphql(gh, "query{viewer{login}}", {});
  return (data.viewer as { login: string }).login;
}

/** The slugs of the teams you belong to; empty when the token cannot read them. */
export async function viewerTeams(gh: Gh): Promise<string[]> {
  const result = await gh(["api", "user/teams", "--paginate"]);
  if (result.code !== 0) return [];
  try {
    return (JSON.parse(result.stdout) as Array<{ slug: string }>).map((t) => t.slug);
  } catch {
    return [];
  }
}

/** The review pack reads a diff tail, not a whole diff: generated files pad the front, changes are everywhere. */
const DIFF_TAIL_CHARS = 200_000;

export async function prDiff(gh: Gh, repo: string, number: number): Promise<string> {
  const result = await gh(["pr", "diff", String(number), "--repo", repo]);
  if (result.code !== 0) throw new Error(`gh pr diff failed: ${describe(result)}`);
  return result.stdout.length > DIFF_TAIL_CHARS ? result.stdout.slice(-DIFF_TAIL_CHARS) : result.stdout;
}

export async function prFiles(gh: Gh, repo: string, number: number): Promise<ReviewContext["files"]> {
  const result = await gh(["pr", "view", String(number), "--repo", repo, "--json", "files"]);
  if (result.code !== 0) throw new Error(`gh pr view failed: ${describe(result)}`);
  const parsed = JSON.parse(result.stdout) as { files?: Array<{ path: string; additions: number; deletions: number }> };
  return (parsed.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
}

/** The inline review comments already on the PR, so the reviewer does not repeat them. */
export async function prComments(gh: Gh, repo: string, number: number): Promise<ReviewContext["existingComments"]> {
  const result = await gh(["api", `repos/${repo}/pulls/${number}/comments`, "--paginate"]);
  if (result.code !== 0) throw new Error(`gh api pulls/comments failed: ${describe(result)}`);
  const rows = JSON.parse(result.stdout) as Array<{ path: string | null; line: number | null; user: { login: string } | null; body: string }>;
  return rows.map((c) => ({ path: c.path ?? null, line: c.line ?? null, author: c.user?.login ?? "ghost", body: c.body }));
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100){nodes{ id isResolved path line
      comments(first:50){nodes{author{login} body createdAt}} }} } } }`;

/** The unresolved review threads, with the ids the host replies to and resolves them by. */
export async function prThreads(gh: Gh, repo: string, number: number): Promise<ThreadsContext["threads"]> {
  const [owner, name] = splitSlug(repo);
  const data = await graphql(gh, THREADS_QUERY, { owner, name, number });
  const repository = data.repository as {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: { nodes: Array<{ author: { login: string } | null; body: string; createdAt: string }> };
        }>;
      };
    } | null;
  } | null;
  const nodes = repository?.pullRequest?.reviewThreads.nodes ?? [];
  return nodes
    .filter((t) => !t.isResolved)
    .map((t) => ({
      id: t.id,
      path: t.path ?? null,
      line: t.line ?? null,
      comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body, at: c.createdAt })),
    }));
}

/** Squash-merges the PR and deletes its branch. Returns gh's error message on failure. */
export async function mergePr(gh: Gh, repo: string, number: number): Promise<string | null> {
  const result = await gh(["pr", "merge", String(number), "--repo", repo, "--squash", "--delete-branch"]);
  return result.code === 0 ? null : `gh pr merge failed: ${describe(result)}`;
}

/** Clones `owner/name` into `dest`. Returns gh's error message on failure. */
export async function cloneRepo(gh: Gh, repo: string, dest: string): Promise<string | null> {
  const result = await gh(["repo", "clone", repo, dest]);
  return result.code === 0 ? null : `gh repo clone failed: ${describe(result)}`;
}

export interface ReviewPost {
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; body: string }>;
}

/** Posts one review with its inline comments. The body goes through a file: argv has no room for it. */
export async function postReview(gh: Gh, repo: string, number: number, review: ReviewPost): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "hardness-review-"));
  const file = join(dir, "review.json");
  await writeFile(file, JSON.stringify(review));
  const result = await gh(["api", "--method", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", file]);
  return result.code === 0 ? null : `gh api pulls/reviews failed: ${describe(result)}`;
}

const REPLY_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}} }`;
const RESOLVE_MUTATION = `mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}} }`;
const RESOLVED_QUERY = `query($threadId:ID!){ node(id:$threadId){ ... on PullRequestReviewThread{isResolved} } }`;

export async function replyToThread(gh: Gh, threadId: string, body: string): Promise<string | null> {
  try {
    await graphql(gh, REPLY_MUTATION, { threadId, body });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function resolveThread(gh: Gh, threadId: string): Promise<string | null> {
  try {
    await graphql(gh, RESOLVE_MUTATION, { threadId });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Whether someone resolved the thread meanwhile; false when GitHub cannot say. */
export async function threadResolved(gh: Gh, threadId: string): Promise<boolean> {
  try {
    const data = await graphql(gh, RESOLVED_QUERY, { threadId });
    return (data.node as { isResolved?: boolean } | null)?.isResolved === true;
  } catch {
    return false;
  }
}
