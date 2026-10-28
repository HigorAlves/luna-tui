// The GitHub port on Octokit (REST, GraphQL and pagination). One client, one token, no CLI.
// The client is injected so a test can hand in a stub shaped like Octokit; `createGitHub`
// builds the real one from a token.
import { Octokit } from "octokit";

import { PR_QUERY, type PrNode } from "../../domain/pull-request.ts";
import {
  type Check,
  type GhIssue,
  GitHubError,
  type GitHub,
  type NewPr,
  type PrRef,
  type PrSearchHit,
  type ReviewPost,
  repoRef,
} from "../../application/github.ts";

/** The slice of Octokit this adapter uses; the real client satisfies it structurally. */
export interface OctokitLike {
  rest: {
    users: { getAuthenticated(): Promise<{ data: { login: string } }> };
    teams: { listForAuthenticatedUser: unknown };
    search: { issuesAndPullRequests(params: { q: string; per_page?: number }): Promise<{ data: { items: Array<{ number: number; repository_url: string; updated_at: string }> } }> };
    pulls: {
      get(params: Record<string, unknown>): Promise<{ data: unknown }>;
      list(params: Record<string, unknown>): Promise<{ data: Array<{ html_url: string; number: number; draft?: boolean }> }>;
      create(params: Record<string, unknown>): Promise<{ data: { html_url: string; number: number; draft?: boolean } }>;
      merge(params: Record<string, unknown>): Promise<unknown>;
      createReview(params: Record<string, unknown>): Promise<unknown>;
      listFiles: unknown;
      listReviewComments: unknown;
    };
    repos: {
      get(params: Record<string, unknown>): Promise<{ data: { default_branch: string } }>;
      getCombinedStatusForRef(params: Record<string, unknown>): Promise<{ data: { statuses: Array<{ context: string; state: string; target_url: string | null }> } }>;
    };
    git: { deleteRef(params: Record<string, unknown>): Promise<unknown> };
    checks: { listForRef(params: Record<string, unknown>): Promise<{ data: { check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }> } }> };
    issues: {
      listForRepo: unknown;
      createComment(params: Record<string, unknown>): Promise<unknown>;
    };
    actions: {
      listJobsForWorkflowRun(params: Record<string, unknown>): Promise<{ data: { jobs: Array<{ id: number; name: string; conclusion: string | null }> } }>;
      downloadJobLogsForWorkflowRun(params: Record<string, unknown>): Promise<{ data: unknown }>;
      reRunWorkflowFailedJobs(params: Record<string, unknown>): Promise<unknown>;
    };
  };
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  paginate<T = unknown>(method: unknown, params?: Record<string, unknown>): Promise<T[]>;
}

/** The review pack reads a diff tail, not a whole diff: generated files pad the front, changes are everywhere. */
export const DIFF_TAIL_CHARS = 200_000;

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100){nodes{ id isResolved path line
      comments(first:50){nodes{author{login} body createdAt}} }} } } }`;
const REPLY_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}} }`;
const RESOLVE_MUTATION = `mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}} }`;
const RESOLVED_QUERY = `query($threadId:ID!){ node(id:$threadId){ ... on PullRequestReviewThread{isResolved} } }`;
const READY_MUTATION = `mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}} }`;

/** Re-throws anything Octokit raises as a GitHubError carrying GitHub's message. */
async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    const message = (error as { message?: string })?.message ?? String(error);
    const status = (error as { status?: number })?.status;
    throw new GitHubError(`${what} failed${status ? ` (${status})` : ""}: ${message}`);
  }
}

/** `owner/name` from the search API's `repository_url` (`https://api.github.com/repos/owner/name`). */
export const slugFromRepositoryUrl = (url: string): string => url.replace(/^.*\/repos\//, "");

/** `gh pr checks`' vocabulary from a check run: the conclusion once complete, the status before. */
export const checkRunState = (run: { status: string; conclusion: string | null }): string =>
  run.status.toLowerCase() === "completed" ? (run.conclusion ?? "neutral").toUpperCase() : run.status.toUpperCase();

export class OctokitGitHub implements GitHub {
  constructor(private readonly octokit: OctokitLike) {}

  async viewer(): Promise<{ login: string; teams: string[] }> {
    const { data } = await call("reading the token's user", () => this.octokit.rest.users.getAuthenticated());
    let teams: string[] = [];
    try {
      const rows = await this.octokit.paginate<{ slug: string }>(this.octokit.rest.teams.listForAuthenticatedUser, { per_page: 100 });
      teams = rows.map((t) => t.slug);
    } catch {
      teams = [];
    }
    return { login: data.login, teams };
  }

  async searchMyPrs(): Promise<PrSearchHit[]> {
    const seen = new Set<string>();
    const hits: PrSearchHit[] = [];
    for (const filter of ["review-requested:@me", "author:@me"]) {
      const { data } = await call("searching pull requests", () =>
        this.octokit.rest.search.issuesAndPullRequests({ q: `is:pr is:open ${filter}`, per_page: 100 }),
      );
      for (const item of data.items) {
        const repo = slugFromRepositoryUrl(item.repository_url);
        const key = `${repo}#${item.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ repo, number: item.number, updatedAt: item.updated_at });
      }
    }
    return hits;
  }

  async prFacts(slug: string, number: number): Promise<PrNode | null> {
    const { owner, repo } = repoRef(slug);
    const data = await call(`reading ${slug}#${number}`, () =>
      this.octokit.graphql<{ repository: { pullRequest: PrNode | null } | null }>(PR_QUERY, { owner, name: repo, number }),
    );
    return data.repository?.pullRequest ?? null;
  }

  async prDiff(slug: string, number: number): Promise<string> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading the diff of ${slug}#${number}`, () =>
      this.octokit.rest.pulls.get({ owner, repo, pull_number: number, mediaType: { format: "diff" } }),
    );
    const text = String(data);
    return text.length > DIFF_TAIL_CHARS ? text.slice(-DIFF_TAIL_CHARS) : text;
  }

  async prFiles(slug: string, number: number) {
    const { owner, repo } = repoRef(slug);
    const files = await call(`listing the files of ${slug}#${number}`, () =>
      this.octokit.paginate<{ filename: string; additions: number; deletions: number }>(this.octokit.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    );
    return files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));
  }

  async prComments(slug: string, number: number) {
    const { owner, repo } = repoRef(slug);
    const rows = await call(`listing the comments of ${slug}#${number}`, () =>
      this.octokit.paginate<{ path: string | null; line: number | null; user: { login: string } | null; body: string }>(
        this.octokit.rest.pulls.listReviewComments,
        { owner, repo, pull_number: number, per_page: 100 },
      ),
    );
    return rows.map((c) => ({ path: c.path ?? null, line: c.line ?? null, author: c.user?.login ?? "ghost", body: c.body }));
  }

  async prThreads(slug: string, number: number) {
    const { owner, repo } = repoRef(slug);
    const data = await call(`reading the threads of ${slug}#${number}`, () =>
      this.octokit.graphql<{
        repository: {
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
      }>(THREADS_QUERY, { owner, name: repo, number }),
    );
    const nodes = data.repository?.pullRequest?.reviewThreads.nodes ?? [];
    return nodes
      .filter((t) => !t.isResolved)
      .map((t) => ({
        id: t.id,
        path: t.path ?? null,
        line: t.line ?? null,
        comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body, at: c.createdAt })),
      }));
  }

  async mergePr(slug: string, number: number): Promise<void> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }));
    const head = (data as { head: { ref: string; repo: { full_name: string } | null } }).head;
    await call(`merging ${slug}#${number}`, () => this.octokit.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: "squash" }));
    // The branch goes with it, as `gh pr merge --delete-branch` did; a fork's branch is not ours to delete.
    if (head.repo?.full_name.toLowerCase() === slug.toLowerCase()) {
      await call(`deleting ${head.ref}`, () => this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head.ref}` }));
    }
  }

  async postReview(slug: string, number: number, review: ReviewPost): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`posting a review on ${slug}#${number}`, () =>
      this.octokit.rest.pulls.createReview({ owner, repo, pull_number: number, event: review.event, body: review.body, comments: review.comments }),
    );
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await call(`replying to thread ${threadId}`, () => this.octokit.graphql(REPLY_MUTATION, { threadId, body }));
  }

  async resolveThread(threadId: string): Promise<void> {
    await call(`resolving thread ${threadId}`, () => this.octokit.graphql(RESOLVE_MUTATION, { threadId }));
  }

  async threadResolved(threadId: string): Promise<boolean> {
    try {
      const data = await this.octokit.graphql<{ node: { isResolved?: boolean } | null }>(RESOLVED_QUERY, { threadId });
      return data.node?.isResolved === true;
    } catch {
      return false;
    }
  }

  async listReadyIssues(slug: string, label: string): Promise<GhIssue[]> {
    const { owner, repo } = repoRef(slug);
    const rows = await call(`listing ${slug} issues labelled ${label}`, () =>
      this.octokit.paginate<{ number: number; title: string; body: string | null; html_url: string; pull_request?: unknown }>(
        this.octokit.rest.issues.listForRepo,
        { owner, repo, labels: label, state: "open", per_page: 50 },
      ),
    );
    // The issues API lists PRs too; intake wants issues.
    return rows.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? null, url: i.html_url }));
  }

  async commentOnIssue(slug: string, number: number, body: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`commenting on ${slug}#${number}`, () => this.octokit.rest.issues.createComment({ owner, repo, issue_number: number, body }));
  }

  async findPr(slug: string, branch: string): Promise<PrRef | null> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`looking for the PR of ${branch}`, () =>
      this.octokit.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open", per_page: 1 }),
    );
    const first = data[0];
    return first ? { url: first.html_url, number: first.number, isDraft: first.draft === true } : null;
  }

  async openPr(slug: string, pr: NewPr): Promise<PrRef> {
    const { owner, repo } = repoRef(slug);
    const base = (await call(`reading ${slug}`, () => this.octokit.rest.repos.get({ owner, repo }))).data.default_branch;
    const { data } = await call(`opening a PR for ${pr.head}`, () =>
      this.octokit.rest.pulls.create({ owner, repo, title: pr.title, body: pr.body, head: pr.head, base, draft: pr.draft }),
    );
    return { url: data.html_url, number: data.number, isDraft: data.draft === true };
  }

  async markPrReady(slug: string, number: number): Promise<void> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }));
    const id = (data as { node_id: string }).node_id;
    await call(`marking ${slug}#${number} ready`, () => this.octokit.graphql(READY_MUTATION, { id }));
  }

  async prChecks(slug: string, ref: string): Promise<Check[]> {
    const { owner, repo } = repoRef(slug);
    const [runs, statuses] = await Promise.all([
      call(`listing the checks on ${ref}`, () => this.octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 })),
      call(`listing the statuses on ${ref}`, () => this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100 })),
    ]);
    return [
      ...runs.data.check_runs.map((run) => ({ name: run.name, state: checkRunState(run), link: run.html_url })),
      ...statuses.data.statuses.map((s) => ({ name: s.context, state: s.state.toUpperCase(), link: s.target_url })),
    ];
  }

  async failedRunLog(slug: string, runId: string): Promise<string> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`listing the jobs of run ${runId}`, () =>
      this.octokit.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: Number(runId), filter: "latest", per_page: 100 }),
    );
    const failed = data.jobs.filter((job) => job.conclusion !== null && job.conclusion !== "success" && job.conclusion !== "skipped" && job.conclusion !== "neutral");
    const logs: string[] = [];
    for (const job of failed) {
      const log = await call(`reading the log of job ${job.name}`, () => this.octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: job.id }));
      logs.push(`== ${job.name} ==\n${String(log.data)}`);
    }
    return logs.join("\n");
  }

  async rerunFailedJobs(slug: string, runId: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`re-running the failed jobs of run ${runId}`, () => this.octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: Number(runId) }));
  }
}

/** The real port, from a token. */
export function createGitHub(token: string): GitHub {
  return new OctokitGitHub(new Octokit({ auth: token }) as unknown as OctokitLike);
}
