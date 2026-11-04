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
      repos: {
        get: endpoint("repos.get"),
        getCombinedStatusForRef: endpoint("repos.getCombinedStatusForRef"),
        getReleaseByTag: endpoint("repos.getReleaseByTag"),
        createRelease: endpoint("repos.createRelease"),
        listReleaseAssets: "repos.listReleaseAssets",
        uploadReleaseAsset: endpoint("repos.uploadReleaseAsset"),
      },
      git: { deleteRef: endpoint("git.deleteRef") },
      checks: { listForRef: endpoint("checks.listForRef") },
      issues: { listForRepo: "issues.listForRepo", createComment: endpoint("issues.createComment"), listComments: "issues.listComments", updateComment: endpoint("issues.updateComment") },
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
      "issues.listForRepo": [{ number: 1, title: "issue", body: null, html_url: "u", labels: [{ name: "bug" }, "ready"] }, { number: 2, title: "pr", body: "", html_url: "u2", pull_request: {} }],
      "pulls.merge": Object.assign(new Error("Pull Request is not mergeable"), { status: 405 }),
      "pulls.get": { head: { ref: "x", repo: null } },
    });
    expect(await github.failedRunLog("o/a", "111")).toBe("== lint ==\nERR at a.ts:1");
    expect(await github.listReadyIssues("o/a", "ready")).toEqual([{ number: 1, title: "issue", body: null, url: "u", labels: ["bug", "ready"] }]);
    await expect(github.mergePr("o/a", 1)).rejects.toThrow(GitHubError);
    await expect(github.mergePr("o/a", 1)).rejects.toThrow(/merging o\/a#1 failed \(405\): Pull Request is not mergeable/);
  });
});

describe("OctokitGitHub: publishing evidence", () => {
  it("updates a PR's body with pulls.update", async () => {
    const { github, calls } = stub({ "pulls.update": {} });
    await github.updatePrBody("o/a", 3, "the body");
    expect(calls).toEqual([["pulls.update", { owner: "o", repo: "a", pull_number: 3, body: "the body" }]]);
  });

  it("lists a PR's comments through the issues API, every page, as id, body and url", async () => {
    const { github, calls } = stub({ "issues.listComments": [{ id: 7, body: "hi", html_url: "u7", user: {} }, { id: 8, body: null, html_url: "u8" }] });
    expect(await github.listPrComments("o/a", 3)).toEqual([{ id: 7, body: "hi", url: "u7" }, { id: 8, body: "", url: "u8" }]);
    expect(calls[0]).toEqual(["paginate issues.listComments", { owner: "o", repo: "a", issue_number: 3, per_page: 100 }]);
  });

  it("updates a comment by its id", async () => {
    const { github, calls } = stub({ "issues.updateComment": {} });
    await github.updateComment("o/a", 7, "new");
    expect(calls).toEqual([["issues.updateComment", { owner: "o", repo: "a", comment_id: 7, body: "new" }]]);
  });

  it("reads the PR's head sha, null when GitHub gives none", async () => {
    expect(await stub({ "pulls.get": { head: { sha: "abc123" } } }).github.prHeadSha("o/a", 3)).toBe("abc123");
    const { github, calls } = stub({ "pulls.get": {} });
    expect(await github.prHeadSha("o/a", 3)).toBeNull();
    expect(calls[0]).toEqual(["pulls.get", { owner: "o", repo: "a", pull_number: 3 }]);
  });

  it("finds a release by its tag, and creates a pre-release when there is none (a 404)", async () => {
    const found = stub({ "repos.getReleaseByTag": { id: 11, html_url: "https://x/releases/tag/luna-evidence" } });
    expect(await found.github.ensureRelease("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true })).toEqual({ id: 11, url: "https://x/releases/tag/luna-evidence" });
    expect(found.calls).toEqual([["repos.getReleaseByTag", { owner: "o", repo: "a", tag: "luna-evidence" }]]);

    const missing = stub({ "repos.getReleaseByTag": Object.assign(new Error("Not Found"), { status: 404 }), "repos.createRelease": { id: 12, html_url: "https://x/releases/tag/luna-evidence" } });
    expect(await missing.github.ensureRelease("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true })).toEqual({ id: 12, url: "https://x/releases/tag/luna-evidence" });
    expect(missing.calls[1]).toEqual(["repos.createRelease", { owner: "o", repo: "a", tag_name: "luna-evidence", name: "Luna evidence", prerelease: true }]);
  });

  it("does not create a release when the lookup fails for another reason", async () => {
    const { github, calls } = stub({ "repos.getReleaseByTag": Object.assign(new Error("Bad credentials"), { status: 401 }) });
    await expect(github.ensureRelease("o/a", "t", { name: "n", prerelease: true })).rejects.toThrow(GitHubError);
    expect(calls.map((c) => c[0])).toEqual(["repos.getReleaseByTag"]);
  });

  it("lists a release's assets, every page, with their download urls", async () => {
    const { github, calls } = stub({ "repos.listReleaseAssets": [{ id: 1, name: "a.png", browser_download_url: "https://x/a.png" }] });
    expect(await github.releaseAssets("o/a", 11)).toEqual([{ id: 1, name: "a.png", url: "https://x/a.png" }]);
    expect(calls[0]).toEqual(["paginate repos.listReleaseAssets", { owner: "o", repo: "a", release_id: 11, per_page: 100 }]);
  });

  it("uploads an asset with its name and content type and answers the download url", async () => {
    const { github, calls } = stub({ "repos.uploadReleaseAsset": { browser_download_url: "https://x/dl/a.png" } });
    const data = Buffer.from("png");
    expect(await github.uploadReleaseAsset("o/a", 11, "t1-abc1234-a.png", data, "image/png")).toEqual({ url: "https://x/dl/a.png" });
    expect(calls[0]).toEqual(["repos.uploadReleaseAsset", { owner: "o", repo: "a", release_id: 11, name: "t1-abc1234-a.png", data, headers: { "content-type": "image/png", "content-length": 3 } }]);
  });

  it("wraps a failed upload as a GitHubError", async () => {
    const { github } = stub({ "repos.uploadReleaseAsset": Object.assign(new Error("Validation Failed"), { status: 422 }) });
    await expect(github.uploadReleaseAsset("o/a", 11, "n", Buffer.from("x"), "image/png")).rejects.toThrow(/422/);
  });
});
