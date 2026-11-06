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
      teams: { listForAuthenticatedUser: "teams.listForAuthenticatedUser", listMembersInOrg: "teams.listMembersInOrg" },
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
        listReviews: "pulls.listReviews",
      },
      repos: {
        get: endpoint("repos.get"),
        getCombinedStatusForRef: endpoint("repos.getCombinedStatusForRef"),
        listReleases: endpoint("repos.listReleases"),
        createRelease: endpoint("repos.createRelease"),
        listReleaseAssets: "repos.listReleaseAssets",
        getContent: endpoint("repos.getContent"),
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
    request: vi.fn(async (route: string, params: unknown) => {
      calls.push([route, params]);
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return { data: typeof answer === "function" ? (answer as (p: unknown) => unknown)(params) : answer };
    }),
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

describe("OctokitGitHub: shipping", () => {
  const head = { head: { ref: "feat/x", repo: { full_name: "o/a" } }, node_id: "PR_node" };
  const allowed = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };

  it("sends the sha guard with the merge, so the commit merged is the one judged", async () => {
    const { github, calls } = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": {}, "git.deleteRef": {} });
    await github.mergePr("o/a", 7, { sha: "abc123" });
    expect(calls.find((c) => c[0] === "pulls.merge")![1]).toMatchObject({ pull_number: 7, merge_method: "squash", sha: "abc123" });
    const bare = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": {}, "git.deleteRef": {} });
    await bare.github.mergePr("o/a", 7);
    expect(bare.calls.find((c) => c[0] === "pulls.merge")![1]).not.toHaveProperty("sha");
  });

  it("enqueues the PR when the merge call says the repo has a merge queue, and keeps the branch for the queue", async () => {
    const queue = Object.assign(new Error("Changes must be made through the merge queue"), { status: 405 });
    const { github, calls } = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": queue, graphql: { enqueuePullRequest: { mergeQueueEntry: { id: "E1" } } } });
    expect(await github.mergePr("o/a", 7, { sha: "abc123" })).toEqual({ queued: true });
    const gql = calls.find((c) => c[0] === "graphql")![1] as { query: string; variables: unknown };
    expect(gql.query).toContain("enqueuePullRequest");
    expect(gql.variables).toMatchObject({ id: "PR_node", sha: "abc123" });
    expect(gql.query).toContain("expectedHeadOid:$sha");
    expect(calls.map((c) => c[0])).not.toContain("git.deleteRef");
  });

  it("names a sha mismatch (409) as the failure it is, and does not enqueue for another 405", async () => {
    const moved = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": Object.assign(new Error("Head branch was modified"), { status: 409 }) });
    await expect(moved.github.mergePr("o/a", 7, { sha: "old" })).rejects.toThrow(/merging o\/a#7 failed \(409\): Head branch was modified/);
    const other = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": Object.assign(new Error("Pull Request is not mergeable"), { status: 405 }) });
    await expect(other.github.mergePr("o/a", 7)).rejects.toThrow(/405/);
    expect(other.calls.map((c) => c[0])).not.toContain("graphql");
  });

  it("answers the merge commit GitHub reports, and null when it names none", async () => {
    const withSha = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": { sha: "m".repeat(40), merged: true }, "git.deleteRef": {} });
    expect(await withSha.github.mergePr("o/a", 7, { sha: "abc123" })).toEqual({ merged: true, sha: "m".repeat(40) });
    const bare = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": {}, "git.deleteRef": {} });
    expect(await bare.github.mergePr("o/a", 7)).toEqual({ merged: true, sha: null });
  });

  it("uses the configured method when the repository allows it, else the fallback order", async () => {
    const methodOf = async (method: "squash" | "merge" | "rebase", settings: Record<string, unknown>) => {
      const { github, calls } = stub({ "pulls.get": head, "repos.get": settings, "pulls.merge": {}, "git.deleteRef": {} });
      await github.mergePr("o/a", 1, { method });
      return (calls.find((c) => c[0] === "pulls.merge")![1] as { merge_method: string }).merge_method;
    };
    expect(await methodOf("rebase", allowed)).toBe("rebase");
    expect(await methodOf("merge", allowed)).toBe("merge");
    expect(await methodOf("rebase", { ...allowed, allow_rebase_merge: false })).toBe("squash");
    expect(await methodOf("squash", { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true })).toBe("rebase");
  });

  it("passes the commit title and message, and keeps the head branch unless deleteBranch is on", async () => {
    const kept = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": {}, "git.deleteRef": {} });
    await kept.github.mergePr("o/a", 7, { title: "T", message: "M", deleteBranch: false });
    expect(kept.calls.find((c) => c[0] === "pulls.merge")![1]).toMatchObject({ commit_title: "T", commit_message: "M" });
    expect(kept.calls.map((c) => c[0])).not.toContain("git.deleteRef");
    const plain = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": {}, "git.deleteRef": {} });
    await plain.github.mergePr("o/a", 7, { deleteBranch: true });
    expect(plain.calls.find((c) => c[0] === "pulls.merge")![1]).not.toHaveProperty("commit_title");
    expect(plain.calls.map((c) => c[0])).toContain("git.deleteRef");
  });

  it("with queue off a merge-queue refusal is an error, not an enqueue", async () => {
    const queue = Object.assign(new Error("Changes must be made through the merge queue"), { status: 405 });
    const { github, calls } = stub({ "pulls.get": head, "repos.get": allowed, "pulls.merge": queue, graphql: {} });
    await expect(github.mergePr("o/a", 7, { queue: false })).rejects.toThrow(/405/);
    expect(calls.map((c) => c[0])).not.toContain("graphql");
  });

  it("deletes a head branch by name, and a branch already gone is not an error", async () => {
    const ok = stub({ "git.deleteRef": {} });
    await ok.github.deleteBranch("o/a", "feat/x");
    expect(ok.calls[0]).toEqual(["git.deleteRef", { owner: "o", repo: "a", ref: "heads/feat/x" }]);
    await expect(stub({ "git.deleteRef": Object.assign(new Error("Reference does not exist"), { status: 422 }) }).github.deleteBranch("o/a", "feat/x")).resolves.toBeUndefined();
    await expect(stub({ "git.deleteRef": Object.assign(new Error("Not Found"), { status: 404 }) }).github.deleteBranch("o/a", "feat/x")).resolves.toBeUndefined();
    await expect(stub({ "git.deleteRef": Object.assign(new Error("boom"), { status: 500 }) }).github.deleteBranch("o/a", "feat/x")).rejects.toThrow(GitHubError);
  });

  it("enqueues by node id", async () => {
    const { github, calls } = stub({ graphql: {} });
    expect(await github.enqueuePr("PR_node", "abc123")).toEqual({ queued: true });
    expect(calls[0]![1]).toMatchObject({ variables: { id: "PR_node", sha: "abc123" } });
  });

  it("reads a file at a ref as text, and gives null for a missing file, a directory, an oversize file or a non-base64 answer", async () => {
    const file = (over: Record<string, unknown> = {}) => ({ type: "file", size: 5, encoding: "base64", content: Buffer.from("* @ana\n").toString("base64"), ...over });
    const ok = stub({ "repos.getContent": file() });
    expect(await ok.github.fileAtRef("o/a", "main", ".github/CODEOWNERS")).toBe("* @ana\n");
    expect(ok.calls[0]![1]).toMatchObject({ owner: "o", repo: "a", path: ".github/CODEOWNERS", ref: "main" });
    expect(await stub({ "repos.getContent": Object.assign(new Error("Not Found"), { status: 404 }) }).github.fileAtRef("o/a", "main", "CODEOWNERS")).toBeNull();
    expect(await stub({ "repos.getContent": [file()] }).github.fileAtRef("o/a", "main", "docs")).toBeNull();
    expect(await stub({ "repos.getContent": file({ size: 300 * 1024 }) }).github.fileAtRef("o/a", "main", "CODEOWNERS")).toBeNull();
    expect(await stub({ "repos.getContent": file({ encoding: "none" }) }).github.fileAtRef("o/a", "main", "CODEOWNERS")).toBeNull();
    await expect(stub({ "repos.getContent": Object.assign(new Error("boom"), { status: 500 }) }).github.fileAtRef("o/a", "main", "CODEOWNERS")).rejects.toThrow(GitHubError);
  });

  it("merges the issue comments, review comments and reviews into one list sorted by time, passing since", async () => {
    const user = (login: string, type = "User") => ({ login, type });
    const { github, calls } = stub({
      "issues.listComments": [{ id: 1, user: user("ana"), author_association: "MEMBER", body: "why?", created_at: "2026-11-04T10:05:00Z", html_url: "u1" }, { id: 2, user: user("ci[bot]", "Bot"), body: "deployed", created_at: "2026-11-04T10:01:00Z", html_url: "u2" }],
      "pulls.listReviewComments": [{ id: 3, user: user("bob"), author_association: "NONE", body: "rename", created_at: "2026-11-04T10:03:00Z", html_url: "u3" }],
      "pulls.listReviews": [
        { id: 4, user: user("cy"), author_association: "COLLABORATOR", body: "", state: "APPROVED", submitted_at: "2026-11-04T10:04:00Z", html_url: "u4" },
        { id: 5, user: user("old"), body: "ok", state: "COMMENTED", submitted_at: "2026-11-04T09:00:00Z", html_url: "u5" },
        { id: 6, user: null, body: "gone", state: "COMMENTED", submitted_at: "2026-11-04T10:06:00Z", html_url: null },
      ],
    });
    const out = await github.prActivity("o/a", 7, "2026-11-04T10:00:00Z");
    expect(out.map((a) => [a.id, a.kind, a.actor, a.isBot, a.state])).toEqual([
      ["comment:2", "comment", "ci[bot]", true, null],
      ["review_comment:3", "review_comment", "bob", false, null],
      ["review:4", "review", "cy", false, "APPROVED"],
      ["comment:1", "comment", "ana", false, null],
      ["review:6", "review", null, false, "COMMENTED"],
    ]);
    expect(out[0]).toMatchObject({ body: "deployed", at: "2026-11-04T10:01:00Z", url: "u2", association: null });
    expect(out.map((a) => [a.id, a.association])).toEqual([["comment:2", null], ["review_comment:3", "NONE"], ["review:4", "COLLABORATOR"], ["comment:1", "MEMBER"], ["review:6", null]]);
    expect(calls.filter((c) => String(c[0]).startsWith("paginate")).map((c) => (c[1] as { since?: string }).since)).toEqual(["2026-11-04T10:00:00Z", "2026-11-04T10:00:00Z", undefined]);
    const all = await stub({ "issues.listComments": [], "pulls.listReviewComments": [], "pulls.listReviews": [{ id: 5, user: user("old"), body: "ok", state: "COMMENTED", submitted_at: "2026-11-04T09:00:00Z", html_url: null }] }).github.prActivity("o/a", 7, null);
    expect(all).toHaveLength(1);
  });

  it("lists every review with its author, state, commit and time, and a team's members by login", async () => {
    const { github, calls } = stub({
      "pulls.listReviews": [{ id: 1, user: { login: "ana" }, state: "APPROVED", commit_id: "abc", submitted_at: "t1", author_association: "MEMBER" }, { id: 2, user: null, state: "COMMENTED", submitted_at: "t2" }],
      "teams.listMembersInOrg": [{ login: "bob" }, { login: "cy" }],
    });
    expect(await github.prReviews("o/a", 7)).toEqual([
      { author: "ana", state: "APPROVED", commitId: "abc", at: "t1", association: "MEMBER" },
      { author: null, state: "COMMENTED", commitId: null, at: "t2", association: null },
    ]);
    expect(await github.teamMembers("acme", "core")).toEqual(["bob", "cy"]);
    expect(calls.at(-1)![1]).toMatchObject({ org: "acme", team_slug: "core", per_page: 100 });
  });

  it("turns a team the token cannot read into a GitHubError", async () => {
    const { github } = stub({ "teams.listMembersInOrg": [] });
    const denied = new OctokitGitHub({
      rest: { teams: { listMembersInOrg: "teams.listMembersInOrg" } },
      paginate: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    } as unknown as OctokitLike);
    await expect(denied.teamMembers("acme", "ghosts")).rejects.toThrow(/404/);
    expect(await github.teamMembers("acme", "core")).toEqual([]);
  });

  it("shapes a merged, an open and a closed PR", async () => {
    const merged = stub({ "pulls.get": { merged: true, merge_commit_sha: "m1", state: "closed", merged_at: "2026-11-04T11:00:00Z" } });
    expect(await merged.github.prMerged("o/a", 7)).toEqual({ merged: true, mergedSha: "m1", state: "closed", mergedAt: "2026-11-04T11:00:00Z" });
    const open = stub({ "pulls.get": { merged: false, merge_commit_sha: "not-a-merge", state: "open", merged_at: null } });
    expect(await open.github.prMerged("o/a", 7)).toEqual({ merged: false, mergedSha: null, state: "open", mergedAt: null });
    const closed = stub({ "pulls.get": { state: "closed" } });
    expect(await closed.github.prMerged("o/a", 7)).toEqual({ merged: false, mergedSha: null, state: "closed", mergedAt: null });
  });
});

describe("OctokitGitHub: publishing evidence", () => {
  it("updates a PR's body with pulls.update", async () => {
    const { github, calls } = stub({ "pulls.update": {} });
    await github.updatePrBody("o/a", 3, "the body");
    expect(calls).toEqual([["pulls.update", { owner: "o", repo: "a", pull_number: 3, body: "the body" }]]);
  });

  it("lists a PR's comments through the issues API, every page, as id, body and url", async () => {
    const { github, calls } = stub({ "issues.listComments": [{ id: 7, body: "hi", html_url: "u7", user: { login: "luna-bot" } }, { id: 8, body: null, html_url: "u8" }] });
    expect(await github.listPrComments("o/a", 3)).toEqual([{ id: 7, body: "hi", url: "u7", author: "luna-bot" }, { id: 8, body: "", url: "u8", author: null }]);
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

  it("finds the release by its tag name among the repo's releases (drafts included), and creates a draft pre-release when there is none: no tag, no release event", async () => {
    const found = stub({ "repos.listReleases": [{ id: 10, tag_name: "v1.0.0", html_url: "https://x/releases/tag/v1.0.0", draft: false }, { id: 11, tag_name: "luna-evidence", html_url: "https://x/releases/tag/luna-evidence", draft: true }] });
    expect(await found.github.ensureRelease("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true })).toEqual({ id: 11, url: "https://x/releases/tag/luna-evidence" });
    expect(found.calls).toEqual([["repos.listReleases", { owner: "o", repo: "a", per_page: 100 }]]);

    const missing = stub({ "repos.listReleases": [], "repos.createRelease": { id: 12, html_url: "https://x/releases/tag/luna-evidence" } });
    expect(await missing.github.ensureRelease("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true })).toEqual({ id: 12, url: "https://x/releases/tag/luna-evidence" });
    expect(missing.calls[1]).toEqual(["repos.createRelease", { owner: "o", repo: "a", tag_name: "luna-evidence", name: "Luna evidence", prerelease: true, draft: true }]);
  });

  it("does not create a release when the lookup fails", async () => {
    const { github, calls } = stub({ "repos.listReleases": Object.assign(new Error("Bad credentials"), { status: 401 }) });
    await expect(github.ensureRelease("o/a", "t", { name: "n", prerelease: true })).rejects.toThrow(GitHubError);
    expect(calls.map((c) => c[0])).toEqual(["repos.listReleases"]);
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

describe("reviewRule", () => {
  const RULES = "GET /repos/{owner}/{repo}/rules/branches/{branch}";
  const BRANCH = "GET /repos/{owner}/{repo}/branches/{branch}";
  const PROTECTION = "GET /repos/{owner}/{repo}/branches/{branch}/protection";
  const denied = (status: number) => Object.assign(new Error("denied"), { status });

  it("reads a pull_request rule of a ruleset that applies to the branch", async () => {
    const { github, calls } = stub({ [RULES]: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true } }] });
    expect(await github.reviewRule("o/a", "release/1")).toEqual({ source: "ruleset", approvals: 2, codeOwners: true });
    expect(calls[0]![1]).toMatchObject({ owner: "o", repo: "a", branch: "release/1" });
  });

  it("falls back to the protection of a protected branch", async () => {
    const { github } = stub({ [RULES]: [], [BRANCH]: { protected: true }, [PROTECTION]: { required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: false } } });
    expect(await github.reviewRule("o/a", "main")).toEqual({ source: "branch_protection", approvals: 1, codeOwners: false });
  });

  it("a protected branch whose protection cannot be read is unreadable, never none", async () => {
    for (const status of [403, 404]) {
      const { github } = stub({ [RULES]: [], [BRANCH]: { protected: true }, [PROTECTION]: denied(status) });
      expect(await github.reviewRule("o/a", "main")).toMatchObject({ source: "unreadable" });
    }
  });

  it("an unprotected branch with no pull_request rule is none; with the rules unreadable it is unreadable", async () => {
    expect(await stub({ [RULES]: [], [BRANCH]: { protected: false } }).github.reviewRule("o/a", "main")).toEqual({ source: "none" });
    expect(await stub({ [RULES]: [{ type: "deletion" }], [BRANCH]: { protected: false } }).github.reviewRule("o/a", "main")).toEqual({ source: "none" });
    expect(await stub({ [RULES]: denied(403), [BRANCH]: { protected: false } }).github.reviewRule("o/a", "main")).toMatchObject({ source: "unreadable" });
    expect(await stub({ [RULES]: [], [BRANCH]: denied(403) }).github.reviewRule("o/a", "main")).toMatchObject({ source: "unreadable" });
  });

  it("protection with no required reviews is none", async () => {
    const { github } = stub({ [RULES]: [], [BRANCH]: { protected: true }, [PROTECTION]: { required_status_checks: {} } });
    expect(await github.reviewRule("o/a", "main")).toEqual({ source: "none" });
  });
});
