// The GitHub port on Octokit (REST, GraphQL and pagination). One client, one token, no CLI.
// The client is injected so a test can hand in a stub shaped like Octokit; `createGitHub`
// builds the real one from a token.
import { isShipCommand, type ReviewRule } from "../../domain/review-rule.ts";
import { Octokit } from "octokit";

import { PR_QUERY, type PrNode, prFields } from "../../domain/pull-request.ts";
import {
  type AlertSeverity,
  type Check,
  type CodeScanningAlert,
  type DependabotAlert,
  type GhIssue,
  GitHubError,
  type GitHub,
  type MergedPr,
  type NewPr,
  type PrActivity,
  type PrRef,
  type PrReview,
  type OpenPrs,
  type PrSearchHit,
  type ReviewPost,
  type RepoPermission,
  type RuleBypass,
  type RulesetBypassActor,
  repoRef,
} from "../../application/github.ts";

/** The slice of Octokit this adapter uses; the real client satisfies it structurally. */
export interface OctokitLike {
  rest: {
    users: { getAuthenticated(): Promise<{ data: { login: string } }> };
    teams: { listForAuthenticatedUser: unknown; listMembersInOrg: unknown };
    search: { issuesAndPullRequests(params: { q: string; per_page?: number; page?: number }): Promise<{ data: { items: Array<{ number: number; repository_url: string; updated_at: string }> } }> };
    pulls: {
      get(params: Record<string, unknown>): Promise<{ data: unknown }>;
      list(params: Record<string, unknown>): Promise<{ data: Array<{ html_url: string; number: number; draft?: boolean }> }>;
      create(params: Record<string, unknown>): Promise<{ data: { html_url: string; number: number; draft?: boolean } }>;
      merge(params: Record<string, unknown>): Promise<unknown>;
      update(params: Record<string, unknown>): Promise<unknown>;
      createReview(params: Record<string, unknown>): Promise<unknown>;
      listFiles: unknown;
      listReviewComments: unknown;
      listReviews: unknown;
    };
    repos: {
      get(params: Record<string, unknown>): Promise<{ data: { default_branch: string; private?: boolean } }>;
      getCombinedStatusForRef(params: Record<string, unknown>): Promise<{ data: { statuses: Array<{ context: string; state: string; target_url: string | null }> } }>;
      listReleases(params: Record<string, unknown>): Promise<{ data: Array<{ id: number; tag_name: string; html_url: string; draft?: boolean; published_at?: string | null }> }>;
      createRelease(params: Record<string, unknown>): Promise<{ data: { id: number; html_url: string } }>;
      updateRelease(params: Record<string, unknown>): Promise<unknown>;
      getLatestRelease(params: Record<string, unknown>): Promise<{ data: { tag_name: string; published_at: string | null } }>;
      listReleaseAssets: unknown;
      getContent(params: Record<string, unknown>): Promise<{ data: unknown }>;
      uploadReleaseAsset(params: Record<string, unknown>): Promise<{ data: { browser_download_url: string } }>;
    };
    git: { deleteRef(params: Record<string, unknown>): Promise<unknown> };
    checks: { listForRef(params: Record<string, unknown>): Promise<{ data: { check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }> } }> };
    issues: {
      listForRepo: unknown;
      get(params: Record<string, unknown>): Promise<{ data: { author_association?: string | null } }>;
      createComment(params: Record<string, unknown>): Promise<unknown>;
      create(params: Record<string, unknown>): Promise<{ data: { number: number; html_url: string } }>;
      listComments: unknown;
      updateComment(params: Record<string, unknown>): Promise<unknown>;
    };
    actions: {
      listJobsForWorkflowRun(params: Record<string, unknown>): Promise<{ data: { jobs: Array<{ id: number; name: string; conclusion: string | null }> } }>;
      downloadJobLogsForWorkflowRun(params: Record<string, unknown>): Promise<{ data: unknown }>;
      reRunWorkflowFailedJobs(params: Record<string, unknown>): Promise<unknown>;
    };
  };
  request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  paginate<T = unknown>(method: unknown, params?: Record<string, unknown>): Promise<T[]>;
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100){nodes{ id isResolved isOutdated path line originalLine
      comments(first:50){nodes{databaseId author{login} authorAssociation body createdAt originalCommit{oid}}} }} } } }`;
const REPLY_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}} }`;
const ENQUEUE_MUTATION = `mutation($id:ID!,$sha:GitObjectID){ enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){ mergeQueueEntry{id} } }`;
/** A file bigger than this is not read through the contents API (CODEOWNERS is small). */
export const FILE_AT_REF_MAX_BYTES = 256 * 1024;
const RESOLVE_MUTATION = `mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}} }`;
const RESOLVED_QUERY = `query($threadId:ID!){ node(id:$threadId){ ... on PullRequestReviewThread{isResolved} } }`;
const READY_MUTATION = `mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}} }`;

/** A comment whose whole body is `/ship` is the release approval when a person writes it, and the machine's comments carry its own login, so the machine never posts one
 *  (the probe has no other way to tell them apart). Every conversation comment the machine writes or edits goes through here. */
function refuseShipCommand(body: string): void {
  if (isShipCommand(body)) throw new GitHubError("refusing to post a comment that is only /ship: that is the release approval, and only a person gives it");
}

/** Re-throws anything Octokit raises as a GitHubError carrying GitHub's message. */
async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    const message = (error as { message?: string })?.message ?? String(error);
    const status = (error as { status?: number })?.status;
    throw new GitHubError(`${what} failed${status ? ` (${status})` : ""}: ${message}`, status);
  }
}

const ORG_ID_QUERY = `query($org:String!){ organization(login:$org){ id } }`;
/** Members asked about per GraphQL call, one alias each. */
const ACTIVITY_BATCH = 10;

/** The merged PRs of a window: the search page, with each PR's first page of reviews (the rest is read by node id). */
const MERGED_PR_FIELDS = `id number title url body author{login} mergedBy{login} mergedAt mergeCommit{oid} baseRefName headRefName
  commits(last:1){nodes{commit{oid}}} closingIssuesReferences(first:10){nodes{number url}}
  reviews(first:100){nodes{author{login} state commit{oid} submittedAt} pageInfo{hasNextPage endCursor}}`;
const MERGED_PRS_QUERY = `query($q:String!,$after:String){ search(query:$q, type:ISSUE, first:50, after:$after){ issueCount pageInfo{hasNextPage endCursor}
  nodes{ ... on PullRequest{ ${MERGED_PR_FIELDS} } } } }`;
const MORE_REVIEWS_QUERY = `query($id:ID!,$after:String){ node(id:$id){ ... on PullRequest{ reviews(first:100, after:$after){nodes{author{login} state commit{oid} submittedAt} pageInfo{hasNextPage endCursor}} } } }`;
/** GitHub's search serves at most this many results of one query. */
const SEARCH_CAP = 1000;

interface ReviewNode {
  author: { login: string } | null;
  state: MergedPr["reviews"][number]["state"];
  commit: { oid: string } | null;
  submittedAt: string | null;
}
interface ReviewsPage {
  nodes: ReviewNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface MergedPrNode {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string | null;
  author: { login: string } | null;
  mergedBy: { login: string } | null;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
  baseRefName: string;
  headRefName: string;
  commits: { nodes: Array<{ commit: { oid: string } }> };
  closingIssuesReferences: { nodes: Array<{ number: number; url: string }> };
  reviews: ReviewsPage;
}
interface MergedPrsAnswer {
  search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<MergedPrNode | null> };
}

const reviewOf = (r: ReviewNode): MergedPr["reviews"][number] => ({ author: r.author?.login ?? null, state: r.state, commitId: r.commit?.oid ?? null, submittedAt: r.submittedAt });
const isoSecond = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** One search page, and how many pages GitHub's search will serve (it stops at 1000 results). */
const SEARCH_PAGE = 100;
const SEARCH_MAX_PAGES = 10;

const AFFILIATIONS = "[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]";
/** The nested lists the bulk read keeps short: it reads hundreds of PRs a call, and GitHub prices a call by the nodes it could return. */
const BULK_LIMITS = { requests: 50, threads: 50, contexts: 50 };
/** Pass 1 pages the repositories this many at a time; it asks for a count and no PR, so a page is cheap. */
const REPOS_PAGE = 100;
/** The most PRs one repo gives per page. */
const BULK_PRS = 50;
/** GitHub prices a call by the PR slots it asks for (repos x `first`, times the nested lists), not by the PRs it gets: a pass 2 call asks for
 *  `first` close to what its repos hold, and holds at most this many repos and about this many slots, so a call stays at a few points. */
const PASS2_MAX_REPOS = 5;
const PASS2_MAX_SLOTS = 125;
/** The `first` a repo with this many open PRs is asked with: the smallest bucket that holds it, and a page of 50 beyond (the rest is paged on its own). */
const PASS2_BUCKETS = [5, 10, 25, 50];
/** A repo's PRs are paged up to this many pages (500 PRs); a repo with more is reported as capped. */
const BULK_MAX_PR_PAGES = 10;

const BULK_PR_FIELDS = prFields(BULK_LIMITS);
const RATE_LIMIT = "rateLimit{cost remaining}";
/** Pass 1: every repo you own, collaborate on or reach through an organisation, with how many PRs it has open and nothing else. Archived repos take no PRs, so they are not asked for. */
const REACHABLE_REPOS_QUERY = `query($after:String){ ${RATE_LIMIT} viewer{ repositories(affiliations:${AFFILIATIONS}, ownerAffiliations:${AFFILIATIONS}, isArchived:false, first:${REPOS_PAGE}, after:$after){
  pageInfo{hasNextPage endCursor}
  nodes{ id nameWithOwner isArchived pullRequests(states:OPEN){ totalCount } } } } }`;
/** Pass 2: the newest open PRs of some repos by id, `first` of each and the fields the inbox reads of each. */
const repoPrsQuery = (first: number) => `query($ids:[ID!]!){ ${RATE_LIMIT} nodes(ids:$ids){ ... on Repository { nameWithOwner
  pullRequests(states:OPEN, first:${first}, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{hasNextPage endCursor} nodes{ ${BULK_PR_FIELDS} } } } } }`;
/** The next page of one repo's open PRs. */
const REPO_PRS_QUERY = `query($owner:String!,$name:String!,$after:String){ ${RATE_LIMIT} repository(owner:$owner,name:$name){
  pullRequests(states:OPEN, first:${BULK_PRS}, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{hasNextPage endCursor} nodes{ ${BULK_PR_FIELDS} } } } }`;

interface PrPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: PrNode[];
}

/** What GitHub says a call cost, on every query of the poll. */
interface RateLimited {
  rateLimit?: { cost: number; remaining: number } | null;
}

interface ReachableReposAnswer extends RateLimited {
  viewer: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ id: string; nameWithOwner: string; isArchived?: boolean; pullRequests: { totalCount: number } }>;
    };
  };
}

interface RepoPrsAnswer extends RateLimited {
  nodes: Array<{ nameWithOwner: string; pullRequests: PrPage } | null>;
}

/** The `first` that pass 2 asks of a repo holding `open` PRs. */
const bucketOf = (open: number): number => PASS2_BUCKETS.find((b) => open <= b) ?? BULK_PRS;

/** Splits the repos of one bucket into calls of at most PASS2_MAX_REPOS repos and about PASS2_MAX_SLOTS requested PRs. */
function chunkRepos<T>(items: T[], first: number): T[][] {
  const size = Math.max(1, Math.min(PASS2_MAX_REPOS, Math.floor(PASS2_MAX_SLOTS / first)));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** `owner/name` from the search API's `repository_url` (`https://api.github.com/repos/owner/name`). */
export const slugFromRepositoryUrl = (url: string): string => url.replace(/^.*\/repos\//, "");

/** `gh pr checks`' vocabulary from a check run: the conclusion once complete, the status before. */
export const checkRunState = (run: { status: string; conclusion: string | null }): string =>
  run.status.toLowerCase() === "completed" ? (run.conclusion ?? "neutral").toUpperCase() : run.status.toUpperCase();

/** What `time_period: "month"` of the rule-suites API covers, counted back from the call. */
const RULE_SUITE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class OctokitGitHub implements GitHub {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
        const { data } = await call("searching pull requests", () =>
          this.octokit.rest.search.issuesAndPullRequests({ q: `is:pr is:open ${filter}`, per_page: SEARCH_PAGE, page }),
        );
        for (const item of data.items) {
          const repo = slugFromRepositoryUrl(item.repository_url);
          const key = `${repo}#${item.number}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ repo, number: item.number, updatedAt: item.updated_at });
        }
        // A short page is the last one; GitHub's search never returns past 1000 results anyway.
        if (data.items.length < SEARCH_PAGE) break;
      }
    }
    return hits;
  }

  /** Two passes, because GitHub prices a call by the PR slots it asks for and most repos hold no open PR. Pass 1 pages every reachable repo for its open count alone;
   *  pass 2 reads the PRs of the repos with some, by id, a few repos a call with `first` close to what they hold. A repo with more than a page is paged on its own. */
  async listOpenPrs(): Promise<OpenPrs> {
    let calls = 0;
    let points = 0;
    let remaining: number | null = null;
    const spend = (answer: RateLimited): void => {
      calls++;
      if (answer.rateLimit) {
        points += answer.rateLimit.cost;
        remaining = answer.rateLimit.remaining;
      }
    };

    // Pass 1: the repos, and how many open PRs each has.
    const withPrs: Array<{ id: string; slug: string; open: number }> = [];
    let after: string | null = null;
    do {
      const data: ReachableReposAnswer = await call("listing the open PRs of your repositories", () =>
        this.octokit.graphql<ReachableReposAnswer>(REACHABLE_REPOS_QUERY, { after }),
      );
      spend(data);
      const repositories = data.viewer.repositories;
      for (const repo of repositories.nodes) {
        if (repo.isArchived || repo.pullRequests.totalCount < 1) continue;
        withPrs.push({ id: repo.id, slug: repo.nameWithOwner, open: repo.pullRequests.totalCount });
      }
      after = repositories.pageInfo.hasNextPage ? repositories.pageInfo.endCursor : null;
    } while (after !== null);

    // Pass 2: the PRs of the repos that have some, grouped by bucket so no call asks for far more than its repos hold.
    const buckets = new Map<number, typeof withPrs>();
    for (const repo of withPrs) {
      const first = bucketOf(repo.open);
      buckets.set(first, [...(buckets.get(first) ?? []), repo]);
    }
    const read = new Map<string, { prs: PrNode[]; page: PrPage; open: number }>();
    const skipped: NonNullable<OpenPrs["skipped"]> = [];
    // GitHub refuses a query it finds too heavy ("Resource limits for this query exceeded"), times out on one (502), or now and then answers
    // nothing: such a call is split in half and asked again, down to one repo, which is then skipped and named. One heavy repo never empties the list.
    const readChunk = async (chunk: typeof withPrs, first: number): Promise<void> => {
      let data: RepoPrsAnswer;
      try {
        data = await call(`listing the open PRs of ${chunk.length} repositories`, async () => {
          const answer = await this.octokit.graphql<RepoPrsAnswer | undefined>(repoPrsQuery(first), { ids: chunk.map((r) => r.id) });
          if (!answer?.nodes) throw new GitHubError("GitHub answered no data");
          return answer;
        });
      } catch (error) {
        if (chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          await readChunk(chunk.slice(0, half), first);
          await readChunk(chunk.slice(half), first);
          return;
        }
        calls++;
        skipped.push({ repo: chunk[0]!.slug, error: String((error as { message?: string })?.message ?? error).split("\n")[0]!.slice(0, 200) });
        return;
      }
      spend(data);
      for (const node of data.nodes) {
        // A repo that went away between the passes answers null.
        if (!node?.pullRequests) continue;
        const open = chunk.find((r) => r.slug === node.nameWithOwner)?.open ?? node.pullRequests.nodes.length;
        read.set(node.nameWithOwner, { prs: [...node.pullRequests.nodes], page: node.pullRequests, open });
      }
    };
    for (const [first, group] of [...buckets].sort((x, y) => x[0] - y[0])) {
      for (const chunk of chunkRepos(group, first)) await readChunk(chunk, first);
    }

    // A repo with more than one page of open PRs is paged on its own, a few pages at most.
    const capped: OpenPrs["capped"] = [];
    for (const [slug, entry] of read) {
      let pages = 1;
      while (entry.page.pageInfo.hasNextPage && pages < BULK_MAX_PR_PAGES) {
        const { owner, repo: name } = repoRef(slug);
        const cursor: string | null = entry.page.pageInfo.endCursor;
        const more: { repository: { pullRequests: PrPage } | null } & RateLimited = await call(`listing the open PRs of ${slug}`, () =>
          this.octokit.graphql<{ repository: { pullRequests: PrPage } | null } & RateLimited>(REPO_PRS_QUERY, { owner, name, after: cursor }),
        );
        spend(more);
        pages++;
        entry.page = more.repository?.pullRequests ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        entry.prs.push(...entry.page.nodes);
      }
      if (entry.page.pageInfo.hasNextPage) capped.push({ repo: slug, open: entry.open });
    }

    // Out in the order pass 1 listed the repos, newest first within a repo.
    const prs: OpenPrs["prs"] = [];
    for (const { slug } of withPrs) {
      for (const node of read.get(slug)?.prs ?? []) prs.push({ repo: slug, node });
    }
    console.log(`github prs (all): ${prs.length} PRs in ${read.size} repos, ${calls} calls, ${points} points, ${remaining ?? "?"} left`);
    if (skipped.length > 0) console.warn(`github prs (all): skipped ${skipped.length} repos GitHub would not read: ${skipped.map((s) => `${s.repo} (${s.error})`).join("; ")}`);
    return { prs, capped, calls, ...(skipped.length > 0 ? { skipped } : {}) };
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
    // Whole: GitHub refuses a diff of over 20,000 lines itself, and the review shards what is big, so nothing is cut here.
    return String(data);
  }

  async prFiles(slug: string, number: number) {
    const { owner, repo } = repoRef(slug);
    const files = await call(`listing the files of ${slug}#${number}`, () =>
      this.octokit.paginate<{ filename: string; previous_filename?: string; additions: number; deletions: number }>(this.octokit.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    );
    // A renamed file lists its previous name too: both names are the PR's own, and both are checked against the control plane.
    return files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) }));
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

  async prThreads(slug: string, number: number, options: { includeResolved?: boolean } = {}) {
    const { owner, repo } = repoRef(slug);
    const data = await call(`reading the threads of ${slug}#${number}`, () =>
      this.octokit.graphql<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                isOutdated?: boolean;
                path: string | null;
                line: number | null;
                originalLine?: number | null;
                comments: { nodes: Array<{ databaseId?: number | null; author: { login: string } | null; authorAssociation?: string | null; body: string; createdAt: string; originalCommit?: { oid: string } | null }> };
              }>;
            };
          } | null;
        } | null;
      }>(THREADS_QUERY, { owner, name: repo, number }),
    );
    const nodes = data.repository?.pullRequest?.reviewThreads.nodes ?? [];
    return nodes
      .filter((t) => options.includeResolved || !t.isResolved)
      .map((t) => ({
        id: t.id,
        path: t.path ?? null,
        line: t.line ?? null,
        resolved: t.isResolved,
        outdated: t.isOutdated ?? false,
        originalLine: t.originalLine ?? null,
        // The commit the thread was opened on is its first comment's: GitHub keeps no originalCommit on the thread itself.
        originalCommit: t.comments.nodes[0]?.originalCommit?.oid ?? null,
        comments: t.comments.nodes.map((c) => ({ ...(typeof c.databaseId === "number" ? { id: c.databaseId } : {}), author: c.author?.login ?? "ghost", body: c.body, at: c.createdAt, association: c.authorAssociation ?? null })),
      }));
  }

  async closePr(slug: string, number: number): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`closing ${slug}#${number}`, () => this.octokit.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" }));
  }

  /** Each repo allows its own merge methods: the configured one when it does, else squash, then a merge commit, then a rebase. */
  private async mergeMethod(owner: string, repo: string, wanted?: "squash" | "merge" | "rebase"): Promise<"squash" | "merge" | "rebase"> {
    try {
      const { data } = await this.octokit.rest.repos.get({ owner, repo });
      const allowed = data as { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean } | undefined;
      const ok = { squash: allowed?.allow_squash_merge !== false, merge: allowed?.allow_merge_commit !== false, rebase: allowed?.allow_rebase_merge !== false };
      if (wanted && ok[wanted]) return wanted;
      if (allowed?.allow_squash_merge === false) {
        if (allowed.allow_merge_commit !== false) return "merge";
        if (allowed.allow_rebase_merge !== false) return "rebase";
      }
      return "squash";
    } catch {
      // The settings are a hint; GitHub's own answer to the merge is the authority.
    }
    return wanted ?? "squash";
  }

  async mergePr(slug: string, number: number, options: { sha?: string; method?: "squash" | "merge" | "rebase"; queue?: boolean; deleteBranch?: boolean; title?: string; message?: string } = {}): Promise<{ merged: true; sha: string | null } | { queued: true }> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }));
    const pr = data as { head: { ref: string; repo: { full_name: string } | null }; node_id?: string };
    const head = pr.head;
    const merge_method = await this.mergeMethod(owner, repo, options.method);
    let sha: string | null = null;
    try {
      const merged = await this.octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: number,
        merge_method,
        ...(options.sha ? { sha: options.sha } : {}),
        ...(options.title ? { commit_title: options.title } : {}),
        ...(options.message ? { commit_message: options.message } : {}),
      });
      const reported = ((merged as { data?: { sha?: unknown } } | undefined)?.data)?.sha;
      sha = typeof reported === "string" && reported ? reported : null;
    } catch (error) {
      const { status, message = "" } = error as { status?: number; message?: string };
      // A repo with a merge queue refuses a direct merge; the queue merges it, and its branch is not ours to delete yet. With `queue: false` the refusal is the answer.
      if (status === 405 && /merge queue/i.test(message) && pr.node_id && options.queue !== false) return this.enqueuePr(pr.node_id, options.sha);
      throw new GitHubError(`merging ${slug}#${number} failed${status ? ` (${status})` : ""}: ${message || String(error)}`, status);
    }
    // The branch goes with it, as `gh pr merge --delete-branch` did; a fork's branch is not ours to delete.
    if (options.deleteBranch !== false && head.repo?.full_name.toLowerCase() === slug.toLowerCase()) {
      await call(`deleting ${head.ref}`, () => this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head.ref}` }));
    }
    return { merged: true, sha };
  }

  async deleteBranch(slug: string, ref: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    try {
      await this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${ref}` });
    } catch (error) {
      const { status } = error as { status?: number };
      if (status === 404 || status === 422) return;
      throw new GitHubError(`deleting ${ref} of ${slug} failed${status ? ` (${status})` : ""}: ${(error as { message?: string }).message ?? String(error)}`);
    }
  }

  async enqueuePr(nodeId: string, sha?: string): Promise<{ queued: true }> {
    await call(`enqueuing ${nodeId}`, () => this.octokit.graphql(ENQUEUE_MUTATION, { id: nodeId, sha: sha ?? null }));
    return { queued: true };
  }

  async fileAtRef(slug: string, ref: string, path: string): Promise<string | null> {
    const { owner, repo } = repoRef(slug);
    let data: unknown;
    try {
      ({ data } = await this.octokit.rest.repos.getContent({ owner, repo, path, ref }));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw new GitHubError(`reading ${path} at ${ref} of ${slug} failed: ${(error as { message?: string }).message ?? String(error)}`);
    }
    const file = data as { type?: string; size?: number; content?: string; encoding?: string } | undefined;
    if (!file || Array.isArray(file) || file.type !== "file" || typeof file.content !== "string" || file.encoding !== "base64") return null;
    if ((file.size ?? 0) > FILE_AT_REF_MAX_BYTES) return null;
    return Buffer.from(file.content, "base64").toString("utf8");
  }

  async prActivity(slug: string, number: number, since: string | null): Promise<PrActivity[]> {
    const { owner, repo } = repoRef(slug);
    type Row = { id: number; user: { login: string; type?: string } | null; author_association?: string | null; body?: string | null; created_at?: string; html_url?: string | null };
    type ReviewRow = { id: number; user: { login: string; type?: string } | null; author_association?: string | null; body?: string | null; state: string; submitted_at?: string | null; html_url?: string | null };
    const sinceParam = since ? { since } : {};
    const [comments, reviewComments, reviews] = await call(`listing the activity of ${slug}#${number}`, () =>
      Promise.all([
        this.octokit.paginate<Row>(this.octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100, ...sinceParam }),
        this.octokit.paginate<Row>(this.octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100, ...sinceParam }),
        this.octokit.paginate<ReviewRow>(this.octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
      ]),
    );
    const isBot = (u: { login: string; type?: string } | null) => u !== null && (u.type === "Bot" || u.login.endsWith("[bot]"));
    const out: PrActivity[] = [
      ...comments.map((c): PrActivity => ({ id: `comment:${c.id}`, kind: "comment", actor: c.user?.login ?? null, isBot: isBot(c.user), association: c.author_association ?? null, body: c.body ?? "", state: null, at: c.created_at ?? "", url: c.html_url ?? null })),
      ...reviewComments.map((c): PrActivity => ({ id: `review_comment:${c.id}`, kind: "review_comment", actor: c.user?.login ?? null, isBot: isBot(c.user), association: c.author_association ?? null, body: c.body ?? "", state: null, at: c.created_at ?? "", url: c.html_url ?? null })),
      ...reviews
        .filter((r) => r.submitted_at && (!since || r.submitted_at > since))
        .map((r): PrActivity => ({ id: `review:${r.id}`, kind: "review", actor: r.user?.login ?? null, isBot: isBot(r.user), association: r.author_association ?? null, body: r.body ?? "", state: r.state, at: r.submitted_at ?? "", url: r.html_url ?? null })),
    ];
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id)));
  }

  async prReviews(slug: string, number: number): Promise<PrReview[]> {
    const { owner, repo } = repoRef(slug);
    const rows = await call(`listing the reviews of ${slug}#${number}`, () =>
      this.octokit.paginate<{ user: { login: string } | null; state: string; commit_id?: string | null; submitted_at?: string | null; author_association?: string | null }>(this.octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    );
    return rows.map((r) => ({ author: r.user?.login ?? null, state: r.state, commitId: r.commit_id ?? null, at: r.submitted_at ?? "", association: r.author_association ?? null }));
  }

  async reviewRule(slug: string, baseRef: string): Promise<ReviewRule> {
    const { owner, repo } = repoRef(slug);
    const branch = baseRef;
    const read = async (route: string): Promise<{ ok: true; data: unknown } | { ok: false; why: string }> => {
      try {
        return { ok: true, data: (await this.octokit.request(route, { owner, repo, branch })).data };
      } catch (error) {
        const { status, message } = error as { status?: number; message?: string };
        return { ok: false, why: `${route.replace(/^GET \/repos\/\{owner\}\/\{repo\}\//, "")} could not be read${status ? ` (${status})` : ""}: ${message ?? "unknown"}` };
      }
    };
    // The rulesets that apply to the branch (by name or pattern, evaluated by GitHub).
    const rules = await read("GET /repos/{owner}/{repo}/rules/branches/{branch}");
    if (rules.ok && Array.isArray(rules.data)) {
      const pulls = (rules.data as Array<{ type?: string; parameters?: { required_approving_review_count?: number; require_code_owner_review?: boolean } }>).filter((r) => r.type === "pull_request");
      if (pulls.length > 0) return { source: "ruleset", approvals: Math.max(...pulls.map((r) => r.parameters?.required_approving_review_count ?? 0)), codeOwners: pulls.some((r) => r.parameters?.require_code_owner_review === true) };
    }
    const info = await read("GET /repos/{owner}/{repo}/branches/{branch}");
    if (!info.ok) return { source: "unreadable", why: info.why };
    if ((info.data as { protected?: boolean } | null)?.protected === true) {
      // A protection the token cannot read (403, 404) says nothing: never "none".
      const protection = await read("GET /repos/{owner}/{repo}/branches/{branch}/protection");
      if (!protection.ok) return { source: "unreadable", why: protection.why };
      const reviews = (protection.data as { required_pull_request_reviews?: { required_approving_review_count?: number; require_code_owner_reviews?: boolean } } | null)?.required_pull_request_reviews;
      if (reviews) return { source: "branch_protection", approvals: reviews.required_approving_review_count ?? 0, codeOwners: reviews.require_code_owner_reviews === true };
    }
    // Nothing found, but a ruleset list that could not be read may have held a rule.
    return rules.ok ? { source: "none" } : { source: "unreadable", why: rules.why };
  }

  async teamMembers(org: string, teamSlug: string): Promise<string[]> {
    const rows = await call(`listing the members of ${org}/${teamSlug}`, () =>
      this.octokit.paginate<{ login: string }>(this.octokit.rest.teams.listMembersInOrg, { org, team_slug: teamSlug, per_page: 100 }),
    );
    return rows.map((m) => m.login);
  }

  async prMerged(slug: string, number: number): Promise<{ merged: boolean; mergedSha: string | null; state: "open" | "closed"; mergedAt: string | null }> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }));
    const pr = data as { merged?: boolean; merge_commit_sha?: string | null; state?: string; merged_at?: string | null };
    const merged = pr.merged === true;
    return { merged, mergedSha: merged ? (pr.merge_commit_sha ?? null) : null, state: pr.state === "open" ? "open" : "closed", mergedAt: merged ? (pr.merged_at ?? null) : null };
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
      this.octokit.paginate<{ number: number; title: string; body: string | null; html_url: string; labels?: Array<string | { name?: string }>; user?: { login?: string } | null; author_association?: string | null; pull_request?: unknown }>(
        this.octokit.rest.issues.listForRepo,
        { owner, repo, labels: label, state: "open", per_page: 50 },
      ),
    );
    // The issues API lists PRs too; intake wants issues.
    return rows
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? null, url: i.html_url, labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean), ...(i.user?.login ? { author: i.user.login } : {}), ...(i.author_association ? { authorAssociation: i.author_association } : {}) }));
  }

  async issueAssociation(slug: string, number: number): Promise<string | null> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.issues.get({ owner, repo, issue_number: number }));
    return data.author_association ? data.author_association : null;
  }

  async commentOnIssue(slug: string, number: number, body: string): Promise<void> {
    refuseShipCommand(body);
    const { owner, repo } = repoRef(slug);
    await call(`commenting on ${slug}#${number}`, () => this.octokit.rest.issues.createComment({ owner, repo, issue_number: number, body }));
  }

  async defaultBranch(slug: string): Promise<string | null> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading the default branch of ${slug}`, () => this.octokit.rest.repos.get({ owner, repo }));
    return typeof data.default_branch === "string" && data.default_branch.length > 0 ? data.default_branch : null;
  }

  async repoPrivate(slug: string): Promise<boolean | null> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading the visibility of ${slug}`, () => this.octokit.rest.repos.get({ owner, repo }));
    return typeof data.private === "boolean" ? data.private : null;
  }

  async createIssue(slug: string, issue: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`creating an issue in ${slug}`, () => this.octokit.rest.issues.create({ owner, repo, title: issue.title, body: issue.body, ...(issue.labels && issue.labels.length > 0 ? { labels: issue.labels } : {}) }));
    return { number: data.number, url: data.html_url };
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
    const base = pr.base ?? (await call(`reading ${slug}`, () => this.octokit.rest.repos.get({ owner, repo }))).data.default_branch;
    const { data } = await call(`opening a PR for ${pr.head}`, () =>
      this.octokit.rest.pulls.create({ owner, repo, title: pr.title, body: pr.body, head: pr.head, base, draft: pr.draft }),
    );
    return { url: data.html_url, number: data.number, isDraft: data.draft === true };
  }

  async retargetPr(slug: string, number: number, base: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`retargeting ${slug}#${number} to ${base}`, () => this.octokit.rest.pulls.update({ owner, repo, pull_number: number, base }));
  }

  async markPrReady(slug: string, number: number): Promise<void> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }));
    const id = (data as { node_id: string }).node_id;
    await call(`marking ${slug}#${number} ready`, () => this.octokit.graphql(READY_MUTATION, { id }));
  }

  async mergedPrs(slug: string, since: string, until: string): Promise<MergedPr[]> {
    repoRef(slug);
    const found = new Map<number, MergedPr>();
    const read = async (from: string, to: string): Promise<void> => {
      const q = `repo:${slug} is:pr is:merged merged:${from}..${to}`;
      const nodes: MergedPrNode[] = [];
      let after: string | null = null;
      for (;;) {
        const cursor: string | null = after;
        const answer: MergedPrsAnswer = await call(`searching the PRs of ${slug} merged ${from}..${to}`, () => this.octokit.graphql<MergedPrsAnswer>(MERGED_PRS_QUERY, { q, after: cursor }));
        // Past the cap the search drops the rest without saying so: read each half of the window on its own instead.
        const [fromMs, toMs] = [Date.parse(from), Date.parse(to)];
        if (answer.search.issueCount > SEARCH_CAP && toMs - fromMs >= 1000) {
          const mid = Math.floor((fromMs + toMs) / 2000) * 1000;
          await read(from, isoSecond(mid));
          await read(isoSecond(mid + 1000), to);
          return;
        }
        nodes.push(...answer.search.nodes.filter((n): n is MergedPrNode => n !== null && typeof n.number === "number"));
        if (!answer.search.pageInfo.hasNextPage) break;
        after = answer.search.pageInfo.endCursor;
      }
      for (const n of nodes) found.set(n.number, await this.mergedPrOf(n, slug));
    };
    await read(since, until);
    return [...found.values()].sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : a.number - b.number));
  }

  private async mergedPrOf(n: MergedPrNode, slug: string): Promise<MergedPr> {
    const reviews = n.reviews.nodes.map(reviewOf);
    let page = n.reviews.pageInfo;
    while (page.hasNextPage) {
      const after = page.endCursor;
      const more = await call(`reading the reviews of ${slug}#${n.number}`, () => this.octokit.graphql<{ node: { reviews: ReviewsPage } | null }>(MORE_REVIEWS_QUERY, { id: n.id, after }));
      if (!more.node) break;
      reviews.push(...more.node.reviews.nodes.map(reviewOf));
      page = more.node.reviews.pageInfo;
    }
    return {
      number: n.number,
      title: n.title,
      url: n.url,
      body: n.body ?? "",
      author: n.author?.login ?? null,
      mergedBy: n.mergedBy?.login ?? null,
      mergedAt: n.mergedAt,
      mergeSha: n.mergeCommit?.oid ?? null,
      baseRef: n.baseRefName,
      headRef: n.headRefName,
      headSha: n.commits.nodes[0]?.commit.oid ?? null,
      closingIssues: n.closingIssuesReferences.nodes.map((i) => ({ number: i.number, url: i.url })),
      reviews,
    };
  }

  async ruleBypasses(slug: string, since: string, until: string): Promise<RuleBypass[] | "unknown"> {
    const { owner, repo } = repoRef(slug);
    // `time_period: "month"` reads back 30 days from now. A window that starts before that has a part the API cannot show: unknown, never "no bypass".
    if (Date.parse(since) < this.now().getTime() - RULE_SUITE_WINDOW_MS) return "unknown";
    type Row = { id: number; actor_name?: string | null; pushed_at?: string; ref?: string; after_sha?: string | null };
    let rows: Row[];
    try {
      rows = await this.octokit.paginate<Row>("GET /repos/{owner}/{repo}/rulesets/rule-suites", { owner, repo, rule_suite_result: "bypass", time_period: "month", per_page: 100 });
    } catch (error) {
      const { status, message } = error as { status?: number; message?: string };
      // A token without the right to read rule suites is a fact to report, not a failure.
      if (status === 403 || status === 404) return "unknown";
      throw new GitHubError(`listing the rule suites of ${slug} failed${status ? ` (${status})` : ""}: ${message ?? String(error)}`);
    }
    const [from, to] = [Date.parse(since), Date.parse(until)];
    return rows
      .filter((r) => r.pushed_at !== undefined && Date.parse(r.pushed_at) >= from && Date.parse(r.pushed_at) <= to)
      .map((r) => ({ ref: r.ref ?? "", actor: r.actor_name ?? null, at: r.pushed_at ?? "", afterSha: r.after_sha ?? null, ruleSuiteId: r.id }));
  }

  async orgMembers(org: string): Promise<Array<{ login: string; role: "admin" | "member" }>> {
    const out: Array<{ login: string; role: "admin" | "member" }> = [];
    for (const role of ["admin", "member"] as const) {
      const rows = await call(`listing the ${role} members of ${org}`, () => this.octokit.paginate<{ login: string }>("GET /orgs/{org}/members", { org, role, per_page: 100 }));
      out.push(...rows.map((m) => ({ login: m.login, role })));
    }
    return out;
  }

  async outsideCollaborators(org: string): Promise<Array<{ login: string }>> {
    const rows = await call(`listing the outside collaborators of ${org}`, () => this.octokit.paginate<{ login: string }>("GET /orgs/{org}/outside_collaborators", { org, per_page: 100 }));
    return rows.map((m) => ({ login: m.login }));
  }

  async orgInvitations(org: string): Promise<Array<{ login: string | null; email: string | null; role: string; createdAt: string; inviter: string | null }>> {
    type Row = { login?: string | null; email?: string | null; role: string; created_at: string; inviter?: { login: string } | null };
    const rows = await call(`listing the invitations of ${org}`, () => this.octokit.paginate<Row>("GET /orgs/{org}/invitations", { org, per_page: 100 }));
    return rows.map((r) => ({ login: r.login ?? null, email: r.email ?? null, role: r.role, createdAt: r.created_at, inviter: r.inviter?.login ?? null }));
  }

  async repoCollaborators(slug: string): Promise<Array<{ login: string; permission: RepoPermission; direct: boolean }>> {
    const { owner, repo } = repoRef(slug);
    type Row = { login: string; role_name?: string; permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean } };
    const list = (affiliation: "all" | "direct") =>
      call(`listing the ${affiliation} collaborators of ${slug}`, () => this.octokit.paginate<Row>("GET /repos/{owner}/{repo}/collaborators", { owner, repo, affiliation, per_page: 100 }));
    const all = await list("all");
    const direct = new Set((await list("direct")).map((r) => r.login));
    const levels: RepoPermission[] = ["admin", "maintain", "write", "triage", "read"];
    // A custom role has no name in the five; its strongest base permission stands for it.
    const permissionOf = (r: Row): RepoPermission => {
      const named = levels.find((l) => l === r.role_name);
      if (named) return named;
      const p = r.permissions ?? {};
      return p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "write" : p.triage ? "triage" : "read";
    };
    return all.map((r) => ({ login: r.login, permission: permissionOf(r), direct: direct.has(r.login) }));
  }

  async rulesetBypassActors(slug: string): Promise<RulesetBypassActor[] | "unknown"> {
    const { owner, repo } = repoRef(slug);
    type Detail = { name: string; bypass_actors?: Array<{ actor_id?: number | null; actor_type: string; bypass_mode?: string }> };
    try {
      const list = await this.octokit.paginate<{ id: number }>("GET /repos/{owner}/{repo}/rulesets", { owner, repo, per_page: 100 });
      const out: RulesetBypassActor[] = [];
      for (const { id } of list) {
        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", { owner, repo, ruleset_id: id });
        const ruleset = data as Detail;
        // GitHub sends bypass_actors only to a caller with write access to the ruleset: absent is not "none".
        if (ruleset.bypass_actors === undefined) return "unknown";
        for (const a of ruleset.bypass_actors) out.push({ ruleset: ruleset.name, actorType: a.actor_type, actorId: a.actor_id ?? null, actorName: null, mode: a.bypass_mode ?? "always" });
      }
      return out;
    } catch (error) {
      const { status, message } = error as { status?: number; message?: string };
      // A token without the right to read rulesets is a fact to report, not a failure.
      if (status === 403 || status === 404) return "unknown";
      throw new GitHubError(`reading the rulesets of ${slug} failed${status ? ` (${status})` : ""}: ${message ?? String(error)}`);
    }
  }

  async adminsEnforced(slug: string, branch: string): Promise<boolean | "unknown"> {
    const { owner, repo } = repoRef(slug);
    try {
      const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", { owner, repo, branch });
      return (data as { enforce_admins?: { enabled?: boolean } } | null)?.enforce_admins?.enabled === true;
    } catch (error) {
      const { status, message } = error as { status?: number; message?: string };
      // GitHub answers 404 "Branch not protected" for a branch with no protection: admins are not held to anything.
      if (status === 404 && /not protected/i.test(message ?? "")) return false;
      if (status === 403 || status === 404) return "unknown";
      throw new GitHubError(`reading the protection of ${slug}@${branch} failed${status ? ` (${status})` : ""}: ${message ?? String(error)}`);
    }
  }

  async memberActivity(org: string, logins: string[], since: string): Promise<Map<string, boolean>> {
    const seen = new Map<string, boolean>();
    if (logins.length === 0) return seen;
    const { organization } = await call(`reading the id of ${org}`, () => this.octokit.graphql<{ organization: { id: string } | null }>(ORG_ID_QUERY, { org }));
    if (!organization) throw new GitHubError(`reading the id of ${org} failed: GitHub does not show the organization`);
    for (let i = 0; i < logins.length; i += ACTIVITY_BATCH) {
      const batch = logins.slice(i, i + ACTIVITY_BATCH);
      const params = batch.map((_, n) => `$l${n}:String!`).join(",");
      const aliases = batch.map((_, n) => `a${n}:user(login:$l${n}){contributionsCollection(organizationID:$org,from:$since){hasAnyContributions}}`).join(" ");
      const variables: Record<string, unknown> = { org: organization.id, since };
      batch.forEach((login, n) => (variables[`l${n}`] = login));
      const data = await call(`reading the activity of ${batch.length} members of ${org}`, () =>
        this.octokit.graphql<Record<string, { contributionsCollection: { hasAnyContributions: boolean } } | null>>(`query($org:ID!,$since:DateTime!,${params}){ ${aliases} }`, variables),
      );
      batch.forEach((login, n) => seen.set(login, data[`a${n}`]?.contributionsCollection.hasAnyContributions === true));
    }
    return seen;
  }

  async dependabotAlerts(slug: string): Promise<DependabotAlert[] | "unknown"> {
    type Row = {
      number: number;
      created_at: string;
      html_url: string;
      dependency?: { package?: { name?: string; ecosystem?: string }; manifest_path?: string };
      security_advisory?: { ghsa_id?: string; cve_id?: string | null; summary?: string; severity?: string };
      security_vulnerability?: { vulnerable_version_range?: string; first_patched_version?: { identifier?: string } | null };
    };
    const rows = await this.openAlerts<Row>(slug, "GET /repos/{owner}/{repo}/dependabot/alerts", "dependabot");
    if (rows === "unknown") return rows;
    return rows.map((r) => ({
      number: r.number,
      package: r.dependency?.package?.name ?? "",
      ecosystem: r.dependency?.package?.ecosystem ?? "",
      severity: alertSeverity(r.security_advisory?.severity),
      manifestPath: r.dependency?.manifest_path ?? "",
      vulnerableRange: r.security_vulnerability?.vulnerable_version_range ?? "",
      patchedVersion: r.security_vulnerability?.first_patched_version?.identifier ?? null,
      ghsa: r.security_advisory?.ghsa_id ?? "",
      cve: r.security_advisory?.cve_id ?? null,
      summary: r.security_advisory?.summary ?? "",
      url: r.html_url,
      createdAt: r.created_at,
    }));
  }

  async codeScanningAlerts(slug: string): Promise<CodeScanningAlert[] | "unknown"> {
    type Row = {
      number: number;
      created_at: string;
      html_url: string;
      rule?: { id?: string | null; severity?: string | null; security_severity_level?: string | null };
      tool?: { name?: string | null };
      most_recent_instance?: { location?: { path?: string } };
    };
    const rows = await this.openAlerts<Row>(slug, "GET /repos/{owner}/{repo}/code-scanning/alerts", "code-scanning");
    if (rows === "unknown") return rows;
    return rows.map((r) => ({
      number: r.number,
      rule: r.rule?.id ?? "",
      // A security rule carries a level of its own; a plain lint rule only error, warning or note.
      severity: alertSeverity(r.rule?.security_severity_level ?? r.rule?.severity),
      tool: r.tool?.name ?? "",
      path: r.most_recent_instance?.location?.path ?? "",
      url: r.html_url,
      createdAt: r.created_at,
    }));
  }

  /** Every open alert of one kind; "unknown" when the token cannot read them (an alert feature that is off answers 404 as well). */
  private async openAlerts<Row>(slug: string, route: string, what: string): Promise<Row[] | "unknown"> {
    const { owner, repo } = repoRef(slug);
    try {
      return await this.octokit.paginate<Row>(route, { owner, repo, state: "open", per_page: 100 });
    } catch (error) {
      const { status, message } = error as { status?: number; message?: string };
      if (status === 403 || status === 404) return "unknown";
      throw new GitHubError(`listing the ${what} alerts of ${slug} failed${status ? ` (${status})` : ""}: ${message ?? String(error)}`);
    }
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

  async updatePrBody(slug: string, number: number, body: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`updating the body of ${slug}#${number}`, () => this.octokit.rest.pulls.update({ owner, repo, pull_number: number, body }));
  }

  async listPrComments(slug: string, number: number): Promise<Array<{ id: number; body: string; url: string; author: string | null }>> {
    const { owner, repo } = repoRef(slug);
    const rows = await call(`listing the comments of ${slug}#${number}`, () =>
      this.octokit.paginate<{ id: number; body?: string | null; html_url: string; user?: { login?: string } | null }>(this.octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    );
    return rows.map((c) => ({ id: c.id, body: c.body ?? "", url: c.html_url, author: c.user?.login ?? null }));
  }

  async updateComment(slug: string, commentId: number, body: string): Promise<void> {
    refuseShipCommand(body);
    const { owner, repo } = repoRef(slug);
    await call(`updating comment ${commentId} on ${slug}`, () => this.octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body }));
  }

  async prHeadSha(slug: string, number: number): Promise<string | null> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`reading ${slug}#${number}`, () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }));
    return (data as { head?: { sha?: string } } | undefined)?.head?.sha ?? null;
  }

  async ensureRelease(slug: string, tag: string, release: { name: string; prerelease: boolean }): Promise<{ id: number; url: string }> {
    const { owner, repo } = repoRef(slug);
    // A draft has no tag to look up by: the first page of releases (drafts included for a token with push) is where it is.
    const { data: releases } = await call(`listing the releases of ${slug}`, () => this.octokit.rest.repos.listReleases({ owner, repo, per_page: 100 }));
    const found = releases.find((r) => r.tag_name === tag);
    if (found) return { id: found.id, url: found.html_url };
    // A draft: no tag is created and no `release` event fires, so the repo's publish or deploy workflows stay out of it.
    const { data } = await call(`creating the ${tag} release of ${slug}`, () =>
      this.octokit.rest.repos.createRelease({ owner, repo, tag_name: tag, name: release.name, prerelease: release.prerelease, draft: true }),
    );
    return { id: data.id, url: data.html_url };
  }

  async releaseAssets(slug: string, releaseId: number): Promise<Array<{ id: number; name: string; url: string }>> {
    const { owner, repo } = repoRef(slug);
    const rows = await call(`listing the assets of release ${releaseId}`, () =>
      this.octokit.paginate<{ id: number; name: string; browser_download_url: string }>(this.octokit.rest.repos.listReleaseAssets, { owner, repo, release_id: releaseId, per_page: 100 }),
    );
    return rows.map((a) => ({ id: a.id, name: a.name, url: a.browser_download_url }));
  }

  async updateReleaseBody(slug: string, releaseId: number, body: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`updating the body of release ${releaseId} of ${slug}`, () => this.octokit.rest.repos.updateRelease({ owner, repo, release_id: releaseId, body }));
  }

  async latestRelease(slug: string): Promise<{ tag: string; publishedAt: string } | null> {
    const { owner, repo } = repoRef(slug);
    try {
      const { data } = await this.octokit.rest.repos.getLatestRelease({ owner, repo });
      return data.published_at ? { tag: data.tag_name, publishedAt: data.published_at } : null;
    } catch (error) {
      const { status, message } = error as { status?: number; message?: string };
      if (status === 404) return null;
      throw new GitHubError(`reading the latest release of ${slug} failed${status ? ` (${status})` : ""}: ${message ?? String(error)}`);
    }
  }

  async recentReleases(slug: string): Promise<Array<{ tag: string; publishedAt: string }>> {
    const { owner, repo } = repoRef(slug);
    const { data } = await call(`listing the releases of ${slug}`, () => this.octokit.rest.repos.listReleases({ owner, repo, per_page: 30 }));
    return data
      .flatMap((r) => (!r.draft && r.published_at ? [{ tag: r.tag_name, publishedAt: r.published_at }] : []))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }

  async uploadReleaseAsset(slug: string, releaseId: number, name: string, data: Buffer, contentType: string): Promise<{ url: string }> {
    const { owner, repo } = repoRef(slug);
    const { data: asset } = await call(`uploading ${name} to release ${releaseId}`, () =>
      this.octokit.rest.repos.uploadReleaseAsset({ owner, repo, release_id: releaseId, name, data, headers: { "content-type": contentType, "content-length": data.length } }),
    );
    return { url: asset.browser_download_url };
  }

  async rerunFailedJobs(slug: string, runId: string): Promise<void> {
    const { owner, repo } = repoRef(slug);
    await call(`re-running the failed jobs of run ${runId}`, () => this.octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: Number(runId) }));
  }
}

/** GitHub's severity word as the port has it: a plain rule's `error`, `warning` and `note` count as high, medium and low. */
function alertSeverity(level: string | null | undefined): AlertSeverity {
  switch (level) {
    case "critical":
      return "critical";
    case "high":
    case "error":
      return "high";
    case "medium":
    case "moderate":
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

/** The real port, from a token. */
export function createGitHub(token: string): GitHub {
  return new OctokitGitHub(new Octokit({ auth: token }) as unknown as OctokitLike);
}
