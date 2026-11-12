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
      return typeof answer === "function" ? (answer as (q: string, v?: Record<string, unknown>) => unknown)(query, variables) : answer;
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

  it("pages through every search result and stops at a short page", async () => {
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => item("o/a", from + i));
    const { github, calls } = stub({
      "search.issuesAndPullRequests": ({ q, page }: { q: string; page: number }) => ({
        items: q.includes("review-requested") ? (page === 1 ? full(1) : page === 2 ? full(101) : [item("o/a", 201)]) : [item("o/a", 5)],
      }),
    });
    const hits = await github.searchMyPrs();
    expect(hits).toHaveLength(201);
    const pages = calls.filter((c) => (c[1] as { q: string }).q.includes("review-requested")).map((c) => (c[1] as { page: number }).page);
    expect(pages).toEqual([1, 2, 3]);
  });

  it("stops paging at GitHub's 1000 result cap", async () => {
    let n = 0;
    const { github, calls } = stub({
      "search.issuesAndPullRequests": ({ q }: { q: string }) => ({ items: q.includes("author") ? [] : Array.from({ length: 100 }, () => item("o/a", ++n)) }),
    });
    expect(await github.searchMyPrs()).toHaveLength(1000);
    expect(calls.filter((c) => (c[1] as { q: string }).q.includes("review-requested"))).toHaveLength(10);
  });

  describe("listOpenPrs (the two-pass read of the all-list)", () => {
    /** A PR node as the bulk query answers it: the fields the per-PR query reads, for `number`. */
    const prNode = (number: number) => ({ number, title: `PR ${number}`, updatedAt: `t${number}`, reviewThreads: { nodes: [] } });
    interface FakeRepo {
      slug: string;
      open: number;
      archived?: boolean;
    }
    /** GitHub as a fake: a viewer with `repos`, each holding `open` open PRs numbered from 1; every answer carries a rateLimit of `cost` points. */
    function world(repos: FakeRepo[], { cost = 1, remaining = 4000 }: { cost?: number; remaining?: number } = {}) {
      const reachable = repos.filter((r) => !r.archived);
      const log: Array<{ kind: "repos" | "nodes" | "page"; query: string; variables: Record<string, unknown> }> = [];
      const prs = (r: FakeRepo, from: number, first: number) => {
        const nodes = Array.from({ length: Math.max(0, Math.min(first, r.open - from)) }, (_, i) => prNode(from + i + 1));
        const more = from + first < r.open;
        return { totalCount: r.open, pageInfo: { hasNextPage: more, endCursor: more ? String(from + first) : null }, nodes };
      };
      const graphql = (query: string, variables: Record<string, unknown> = {}) => {
        const rateLimit = { cost, remaining: remaining - log.length * cost };
        if (query.includes("repositories(")) {
          log.push({ kind: "repos", query, variables });
          const from = variables.after == null ? 0 : Number(variables.after);
          const page = reachable.slice(from, from + 100);
          const end = from + page.length;
          return {
            rateLimit,
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: end < reachable.length, endCursor: end < reachable.length ? String(end) : null },
                nodes: page.map((r) => ({ id: `id:${r.slug}`, nameWithOwner: r.slug, isArchived: false, pullRequests: { totalCount: r.open } })),
              },
            },
          };
        }
        if (query.includes("nodes(ids")) {
          log.push({ kind: "nodes", query, variables });
          const first = Number(/first:(\d+)/.exec(query)![1]);
          const ids = variables.ids as string[];
          return {
            rateLimit,
            nodes: ids.map((id) => {
              const r = repos.find((x) => `id:${x.slug}` === id)!;
              return { nameWithOwner: r.slug, pullRequests: prs(r, 0, first) };
            }),
          };
        }
        log.push({ kind: "page", query, variables });
        const r = repos.find((x) => x.slug === `${variables.owner}/${variables.name}`)!;
        return { rateLimit, repository: { pullRequests: prs(r, Number(variables.after), 50) } };
      };
      return { graphql, log };
    }
    const asked = (log: ReturnType<typeof world>["log"]) => log.filter((l) => l.kind === "nodes");
    const firstOf = (query: string) => Number(/pullRequests\(states:OPEN, first:(\d+)/.exec(query)![1]);

    /** The fake, refusing the pass 2 calls `refuse` picks: GitHub's resource limit, a 502, or an empty answer. */
    function refusing(w: ReturnType<typeof world>, refuse: (ids: string[]) => "limit" | "502" | "empty" | null) {
      return async (query: string, variables: Record<string, unknown> = {}) => {
        if (query.includes("nodes(ids")) {
          const how = refuse(variables.ids as string[]);
          if (how === "limit") throw new Error("Request failed due to following response errors:\n - Resource limits for this query exceeded.");
          if (how === "502") throw Object.assign(new Error("<html>502 Bad Gateway</html>"), { status: 502 });
          if (how === "empty") return undefined;
        }
        return w.graphql(query, variables);
      };
    }
    const many = Array.from({ length: 8 }, (_, i) => ({ slug: `o/r${i}`, open: 3 }));

    it("splits a pass 2 call GitHub refuses as too big and still reads every repo", async () => {
      const w = world(many);
      const { github } = stub({ graphql: refusing(w, (ids) => (ids.length > 2 ? "limit" : null)) });
      const listed = await github.listOpenPrs();
      expect(new Set(listed.prs.map((p) => p.repo))).toEqual(new Set(many.map((r) => r.slug)));
      expect(listed.prs).toHaveLength(24);
      expect(listed.skipped ?? []).toEqual([]);
    });

    it("treats a 502 or an empty answer as a failed call to split, never as a crash", async () => {
      for (const how of ["502", "empty"] as const) {
        const w = world(many);
        const { github } = stub({ graphql: refusing(w, (ids) => (ids.length > 1 ? how : null)) });
        const listed = await github.listOpenPrs();
        expect(listed.prs, how).toHaveLength(24);
      }
    });

    it("skips one repo GitHub keeps refusing, names it, and lists the rest", async () => {
      const w = world(many);
      const { github } = stub({ graphql: refusing(w, (ids) => (ids.includes("id:o/r3") ? "limit" : null)) });
      const listed = await github.listOpenPrs();
      expect(listed.prs.some((p) => p.repo === "o/r3")).toBe(false);
      expect(listed.prs).toHaveLength(21);
      expect(listed.skipped?.map((s) => s.repo)).toEqual(["o/r3"]);
    });

    it("pass 1 pages the repositories 100 at a time, asking only for each one's open count", async () => {
      const repos = Array.from({ length: 250 }, (_, i) => ({ slug: `o/r${i}`, open: 0 }));
      const w = world(repos);
      const { github } = stub({ graphql: w.graphql });
      const listed = await github.listOpenPrs();
      const pass1 = w.log.filter((l) => l.kind === "repos");
      expect(pass1.map((l) => l.variables.after ?? null)).toEqual([null, "100", "200"]);
      const query = pass1[0]!.query;
      expect(query).toContain("affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]");
      expect(query).toContain("ownerAffiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]");
      expect(query).toContain("isArchived:false");
      expect(query).toMatch(/repositories\([^)]*first:100[,)]/);
      expect(query).toContain("rateLimit{cost remaining}");
      expect(query).toMatch(/pullRequests\(states:OPEN\)\s*\{\s*totalCount\s*\}/);
      // No PR fields in pass 1, and no repo without an open PR is read again.
      expect(query).not.toContain("reviewThreads");
      expect(query).not.toContain("nodes{ id number");
      expect(asked(w.log)).toHaveLength(0);
      expect(listed).toEqual({ prs: [], capped: [], calls: 3 });
    });

    it("pass 2 reads only repos with an open PR, grouped by how many they hold, in the repo order of pass 1", async () => {
      const repos: FakeRepo[] = [
        { slug: "o/big", open: 30 },
        { slug: "o/none", open: 0 },
        { slug: "o/one", open: 1 },
        { slug: "o/five", open: 5 },
        { slug: "o/six", open: 6 },
        { slug: "o/ten", open: 10 },
        { slug: "o/eleven", open: 11 },
        { slug: "o/fifty", open: 50 },
        { slug: "o/fiftyone", open: 51 },
      ];
      const w = world(repos);
      const { github } = stub({ graphql: w.graphql });
      const listed = await github.listOpenPrs();
      const nodes = asked(w.log);
      const byFirst: Record<number, string[]> = {};
      for (const n of nodes) byFirst[firstOf(n.query)] = [...(byFirst[firstOf(n.query)] ?? []), ...(n.variables.ids as string[]).map((id) => id.slice(3))];
      expect(byFirst).toEqual({
        5: ["o/one", "o/five"],
        10: ["o/six", "o/ten"],
        25: ["o/eleven"],
        50: ["o/big", "o/fifty", "o/fiftyone"],
      });
      expect(nodes[0]!.query).toContain("rateLimit{cost remaining}");
      expect(nodes[0]!.query).toContain("orderBy:{field:UPDATED_AT, direction:DESC}");
      // The same fields as the per-PR query, nested lists kept short.
      expect(nodes[0]!.query).toContain("reviewDecision mergeable mergeStateStatus");
      expect(nodes[0]!.query).toContain("statusCheckRollup{state contexts(first:50)");
      expect(nodes[0]!.query).toContain("reviewThreads(first:50)");
      expect(nodes[0]!.query).toContain("commits(last:1)");
      const counts = new Map<string, number>();
      for (const p of listed.prs) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
      // o/fiftyone holds 51 and is paged by one more call; nothing is capped.
      expect([...counts]).toEqual([["o/big", 30], ["o/one", 1], ["o/five", 5], ["o/six", 6], ["o/ten", 10], ["o/eleven", 11], ["o/fifty", 50], ["o/fiftyone", 51]]);
      expect(listed.capped).toEqual([]);
      // first:50 holds two repos a call (2 x 50 slots within 125), so its three repos take two calls.
      expect(listed.calls).toBe(1 + 5 + 1);
    });

    it("maps the PR fields as before", async () => {
      const w = world([{ slug: "o/a", open: 2 }]);
      const { github } = stub({ graphql: w.graphql });
      const listed = await github.listOpenPrs();
      expect(listed.prs.map((p) => [p.repo, p.node.number, p.node.updatedAt])).toEqual([["o/a", 1, "t1"], ["o/a", 2, "t2"]]);
    });

    it("caps the repos of one call at five, and the PRs it asks for at about 125", async () => {
      const small = Array.from({ length: 23 }, (_, i) => ({ slug: `o/s${i}`, open: 1 }));
      const large = Array.from({ length: 12 }, (_, i) => ({ slug: `o/l${i}`, open: 40 }));
      const w = world([...small, ...large]);
      const { github } = stub({ graphql: w.graphql });
      const listed = await github.listOpenPrs();
      const nodes = asked(w.log);
      for (const n of nodes) {
        const ids = n.variables.ids as string[];
        expect(ids.length).toBeLessThanOrEqual(5);
        expect(ids.length * firstOf(n.query)).toBeLessThanOrEqual(125);
      }
      // 23 small repos at first:5: 5 + 5 + 5 + 5 + 3; 12 repos at first:50: two a call.
      expect(nodes.map((n) => (n.variables.ids as string[]).length)).toEqual([5, 5, 5, 5, 3, 2, 2, 2, 2, 2, 2]);
      expect(listed.prs).toHaveLength(23 + 12 * 40);
    });

    it("pages a repo with more than 50 open PRs on its own and reports one past the ceiling as capped", async () => {
      const w = world([{ slug: "o/huge", open: 4000 }, { slug: "o/paged", open: 120 }]);
      const { github } = stub({ graphql: w.graphql });
      const listed = await github.listOpenPrs();
      expect(listed.prs.filter((p) => p.repo === "o/paged")).toHaveLength(120);
      expect(listed.prs.filter((p) => p.repo === "o/huge")).toHaveLength(500);
      expect(listed.capped).toEqual([{ repo: "o/huge", open: 4000 }]);
      const pages = w.log.filter((l) => l.kind === "page");
      expect(pages.filter((p) => p.variables.name === "paged").map((p) => p.variables.after)).toEqual(["50", "100"]);
      expect(listed.calls).toBe(1 + 1 + pages.length);
    });

    it("skips archived repositories", async () => {
      const w = world([{ slug: "o/live", open: 1 }, { slug: "o/old", open: 3, archived: true }]);
      const { github } = stub({ graphql: w.graphql });
      const listed = await github.listOpenPrs();
      expect(listed.prs.map((p) => p.repo)).toEqual(["o/live"]);
      expect(asked(w.log).flatMap((n) => n.variables.ids as string[])).toEqual(["id:o/live"]);
    });

    it("skips a repo the first pass reports archived even when the filter let it through", async () => {
      const { github } = stub({
        graphql: (query: string) =>
          query.includes("repositories(")
            ? { viewer: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "i", nameWithOwner: "o/old", isArchived: true, pullRequests: { totalCount: 2 } }] } } }
            : { nodes: [] },
      });
      expect(await github.listOpenPrs()).toEqual({ prs: [], capped: [], calls: 1 });
    });

    it("logs one line per poll with the PRs, repos, calls, points spent and points left", async () => {
      const w = world([{ slug: "o/a", open: 2 }, { slug: "o/b", open: 1 }, { slug: "o/c", open: 0 }], { cost: 3, remaining: 4000 });
      const { github } = stub({ graphql: w.graphql });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const listed = await github.listOpenPrs();
        // One page of repos, and one call for o/a and o/b together (both first:5).
        expect(listed.calls).toBe(2);
        expect(log.mock.calls.flat().filter((l) => String(l).startsWith("github prs (all):"))).toEqual(["github prs (all): 3 PRs in 2 repos, 2 calls, 6 points, 3997 left"]);
      } finally {
        log.mockRestore();
      }
    });

    it("sums the cost of every call, the paging ones included", async () => {
      const w = world([{ slug: "o/p", open: 60 }], { cost: 2, remaining: 100 });
      const { github } = stub({ graphql: w.graphql });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await github.listOpenPrs();
        expect(log.mock.calls.flat().join("\n")).toContain("60 PRs in 1 repos, 3 calls, 6 points, 96 left");
      } finally {
        log.mockRestore();
      }
    });

    it("still answers when GitHub reports no rateLimit", async () => {
      const { github } = stub({
        graphql: (query: string) =>
          query.includes("repositories(")
            ? { viewer: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "i", nameWithOwner: "o/a", isArchived: false, pullRequests: { totalCount: 1 } }] } } }
            : { nodes: [{ nameWithOwner: "o/a", pullRequests: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [prNode(1)] } }] },
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect((await github.listOpenPrs()).prs).toHaveLength(1);
      } finally {
        log.mockRestore();
      }
    });

    it("keeps GitHub's own message in the error of a failed pass", async () => {
      const { github } = stub({ graphql: new Error("API rate limit exceeded") });
      await expect(github.listOpenPrs()).rejects.toThrow(/API rate limit exceeded/);
    });
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

  it("opens a PR against the base it is given (a stacked card's parent branch), else the default branch, and retargets one by updating its base", async () => {
    const { github, calls } = stub({ "repos.get": { default_branch: "main" }, "pulls.create": { html_url: "https://x/pull/9", number: 9, draft: true }, "pulls.update": {} });
    await github.openPr("o/a", { title: "t", body: "b", head: "task/child", draft: true, base: "task/parent" });
    expect(calls.find((c) => c[0] === "pulls.create")![1]).toMatchObject({ base: "task/parent", head: "task/child" });
    expect(calls.some((c) => c[0] === "repos.get")).toBe(false);
    await github.retargetPr("o/a", 9, "main");
    expect(calls.at(-1)).toEqual(["pulls.update", { owner: "o", repo: "a", pull_number: 9, base: "main" }]);
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

  it("reads each thread comment with its author's association", async () => {
    const { github, calls } = stub({ graphql: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T1", isResolved: false, path: "a.ts", line: 3, comments: { nodes: [{ author: { login: "bo" }, authorAssociation: "MEMBER", body: "x", createdAt: "t" }, { author: null, body: "y", createdAt: "t2" }] } }] } } } } });
    expect(await github.prThreads("o/a", 3)).toEqual([{ id: "T1", path: "a.ts", line: 3, comments: [{ author: "bo", body: "x", at: "t", association: "MEMBER" }, { author: "ghost", body: "y", at: "t2", association: null }] }]);
    expect(String((calls[0]![1] as { query: string }).query)).toContain("authorAssociation");
  });

  it("lists the files of a PR with the previous name of a renamed one", async () => {
    const { github } = stub({ "pulls.listFiles": [{ filename: "src/n.test.ts", previous_filename: ".github/CODEOWNERS", additions: 1, deletions: 0 }, { filename: "src/a.ts", additions: 2, deletions: 1 }] });
    expect(await github.prFiles("o/a", 7)).toEqual([
      { path: "src/n.test.ts", additions: 1, deletions: 0, previousPath: ".github/CODEOWNERS" },
      { path: "src/a.ts", additions: 2, deletions: 1 },
    ]);
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

  it("never posts a comment whose whole body is /ship: that is the release approval, and the machine's own login must not be able to give it", async () => {
    const { github, calls } = stub({ "issues.createComment": {}, "issues.updateComment": {} });
    for (const body of ["/ship", "  /SHIP\n"]) {
      await expect(github.commentOnIssue("o/a", 3, body)).rejects.toThrow(GitHubError);
      await expect(github.updateComment("o/a", 7, body)).rejects.toThrow(/\/ship/);
    }
    expect(calls).toEqual([]);
    await github.commentOnIssue("o/a", 3, "/ship it");
    expect(calls).toEqual([["issues.createComment", { owner: "o", repo: "a", issue_number: 3, body: "/ship it" }]]);
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
