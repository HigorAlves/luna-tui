import { describe, expect, it, vi } from "vitest";

import { GitHubError } from "../../application/github.ts";
import { OctokitGitHub, type OctokitLike, checkRunState, slugFromRepositoryUrl } from "./octokit.ts";

/** An Octokit-shaped stub: each endpoint answers from `answers`, every call is recorded. */
function stub(answers: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = [];
  const endpoint = (name: string) =>
    vi.fn(async (params: unknown) => {
      calls.push([name, params]);
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return { data: typeof answer === "function" ? (answer as (p: unknown) => unknown)(params) : answer };
    });
  const octokit = {
    rest: {
      users: { getAuthenticated: endpoint("users.getAuthenticated") },
      teams: { listForAuthenticatedUser: "teams.listForAuthenticatedUser" },
      search: { issuesAndPullRequests: endpoint("search.issuesAndPullRequests") },
      pulls: {
        update: endpoint("pulls.update"),
        get: endpoint("pulls.get"),
        list: endpoint("pulls.list"),
        create: endpoint("pulls.create"),
        merge: endpoint("pulls.merge"),
        createReview: endpoint("pulls.createReview"),
        listFiles: "pulls.listFiles",
        listReviewComments: "pulls.listReviewComments",
      },
      repos: { get: endpoint("repos.get"), getCombinedStatusForRef: endpoint("repos.getCombinedStatusForRef") },
      git: { deleteRef: endpoint("git.deleteRef") },
      checks: { listForRef: endpoint("checks.listForRef") },
      issues: { listForRepo: "issues.listForRepo", createComment: endpoint("issues.createComment") },
      actions: {
        listJobsForWorkflowRun: endpoint("actions.listJobsForWorkflowRun"),
        downloadJobLogsForWorkflowRun: endpoint("actions.downloadJobLogsForWorkflowRun"),
        reRunWorkflowFailedJobs: endpoint("actions.reRunWorkflowFailedJobs"),
      },
    },
    graphql: vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      calls.push(["graphql", { query, variables }]);
      const answer = answers.graphql;
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? (answer as (q: string) => unknown)(query) : answer;
    }),
    paginate: vi.fn(async (method: unknown, params?: Record<string, unknown>) => {
      calls.push([`paginate ${String(method)}`, params]);
      return answers[String(method)] as unknown[];
    }),
  } as unknown as OctokitLike;
  return { github: new OctokitGitHub(octokit), calls };
}

const item = (repo: string, number: number) => ({ number, repository_url: `https://api.github.com/repos/${repo}`, updated_at: "t" });

describe("OctokitGitHub", () => {
  it("maps the search API to hits, deduped across the two queries", async () => {
    const { github, calls } = stub({
      "search.issuesAndPullRequests": ({ q }: { q: string }) => ({
        items: q.includes("review-requested") ? [item("o/a", 1), item("o/b", 2)] : [item("o/b", 2), item("o/a", 3)],
      }),
    });
    expect(await github.searchMyPrs()).toEqual([
      { repo: "o/a", number: 1, updatedAt: "t" },
      { repo: "o/b", number: 2, updatedAt: "t" },
      { repo: "o/a", number: 3, updatedAt: "t" },
    ]);
    expect(calls.map((c) => (c[1] as { q: string }).q)).toEqual(["is:pr is:open review-requested:@me", "is:pr is:open author:@me"]);
    expect(slugFromRepositoryUrl("https://api.github.com/repos/o/a")).toBe("o/a");
  });

  it("speaks gh pr checks' vocabulary for check runs and statuses", async () => {
    const { github } = stub({
      "checks.listForRef": { check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: "u1" }, { name: "e2e", status: "in_progress", conclusion: null, html_url: null }] },
      "repos.getCombinedStatusForRef": { statuses: [{ context: "lint", state: "failure", target_url: null }] },
    });
    expect(await github.prChecks("o/a", "feat/x")).toEqual([
      { name: "build", state: "SUCCESS", link: "u1" },
      { name: "e2e", state: "IN_PROGRESS", link: null },
      { name: "lint", state: "FAILURE", link: null },
    ]);
    expect(checkRunState({ status: "completed", conclusion: null })).toBe("NEUTRAL");
  });

  it("merges with squash and deletes the head branch only when it lives in the same repo", async () => {
    const allowed = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };
    const same = stub({ "pulls.get": { head: { ref: "feat/x", repo: { full_name: "o/a" } } }, "repos.get": allowed, "pulls.merge": {}, "git.deleteRef": {} });
    await same.github.mergePr("o/a", 7);
    expect(same.calls.map((c) => c[0])).toEqual(["pulls.get", "repos.get", "pulls.merge", "git.deleteRef"]);
    expect(same.calls[2]![1]).toMatchObject({ owner: "o", repo: "a", pull_number: 7, merge_method: "squash" });
    expect(same.calls[3]![1]).toMatchObject({ ref: "heads/feat/x" });
    const fork = stub({ "pulls.get": { head: { ref: "feat/x", repo: { full_name: "them/a" } } }, "repos.get": allowed, "pulls.merge": {} });
    await fork.github.mergePr("o/a", 7);
    expect(fork.calls.map((c) => c[0])).toEqual(["pulls.get", "repos.get", "pulls.merge"]);
  });

  it("merges the way the repo allows: squash first, then a merge commit, then rebase", async () => {
    const methodOf = async (settings: Record<string, unknown> | Error) => {
      const { github, calls } = stub({ "pulls.get": { head: { ref: "f", repo: { full_name: "them/a" } } }, "repos.get": settings, "pulls.merge": {} });
      await github.mergePr("o/a", 1);
      return (calls.find((c) => c[0] === "pulls.merge")![1] as { merge_method: string }).merge_method;
    };
    expect(await methodOf({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true })).toBe("merge");
    expect(await methodOf({ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true })).toBe("rebase");
    expect(await methodOf({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false })).toBe("squash");
    expect(await methodOf(new Error("no admin"))).toBe("squash");
    expect(await methodOf({})).toBe("squash");
  });

  it("closes a PR by updating its state and leaves the branch alone", async () => {
    const { github, calls } = stub({ "pulls.update": {} });
    await github.closePr("o/a", 7);
    expect(calls).toEqual([["pulls.update", { owner: "o", repo: "a", pull_number: 7, state: "closed" }]]);
  });

  it("posts a review as one call, finds a PR by head, opens one against the default branch, and marks ready through GraphQL", async () => {
    const { github, calls } = stub({
      "pulls.createReview": {},
      "pulls.list": [{ html_url: "https://x/pull/3", number: 3, draft: true }],
      "repos.get": { default_branch: "main" },
      "pulls.create": { html_url: "https://x/pull/9", number: 9, draft: false },
      "pulls.get": { node_id: "PR_1" },
      graphql: {},
    });
    await github.postReview("o/a", 3, { event: "COMMENT", body: "b", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }] });
    expect(calls.at(-1)).toEqual(["pulls.createReview", { owner: "o", repo: "a", pull_number: 3, event: "COMMENT", body: "b", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }] }]);
    expect(await github.findPr("o/a", "feat/x")).toEqual({ url: "https://x/pull/3", number: 3, isDraft: true });
    expect(calls.at(-1)![1]).toMatchObject({ head: "o:feat/x", state: "open" });
    expect(await github.openPr("o/a", { title: "t", body: "b", head: "feat/x", draft: true })).toEqual({ url: "https://x/pull/9", number: 9, isDraft: false });
    expect(calls.at(-1)![1]).toMatchObject({ base: "main", head: "feat/x", draft: true });
    await github.markPrReady("o/a", 3);
    expect(calls.at(-1)![1]).toMatchObject({ variables: { id: "PR_1" } });
  });

  it("joins the failed jobs' logs, filters PRs out of the issue list, and wraps failures as GitHubError", async () => {
    const { github } = stub({
      "actions.listJobsForWorkflowRun": { jobs: [{ id: 1, name: "lint", conclusion: "failure" }, { id: 2, name: "unit", conclusion: "success" }] },
      "actions.downloadJobLogsForWorkflowRun": "ERR at a.ts:1",
      "issues.listForRepo": [{ number: 1, title: "issue", body: null, html_url: "u" }, { number: 2, title: "pr", body: "", html_url: "u2", pull_request: {} }],
      "pulls.merge": Object.assign(new Error("Pull Request is not mergeable"), { status: 405 }),
      "pulls.get": { head: { ref: "x", repo: null } },
    });
    expect(await github.failedRunLog("o/a", "111")).toBe("== lint ==\nERR at a.ts:1");
    expect(await github.listReadyIssues("o/a", "ready")).toEqual([{ number: 1, title: "issue", body: null, url: "u" }]);
    await expect(github.mergePr("o/a", 1)).rejects.toThrow(GitHubError);
    await expect(github.mergePr("o/a", 1)).rejects.toThrow(/merging o\/a#1 failed \(405\): Pull Request is not mergeable/);
  });
});
