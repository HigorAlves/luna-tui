// OpenAPI route definitions of the PR inbox: each route's request and every response it can give, in zod.
// The response schemas are held to the contracts' types with `expectSame`.
import { PrActionInput, type CloneStatus, type IssueHit, type PrActivity, type PrDetail, type PrFacts, type PrLink, type PrSnapshot, type PullRequest } from "@hardness/contracts";
import { CloneInput, ChecksState, IssueKind, OpenPrInput, PrAction, PrActivityKind, PrMenuAction, PrSplit } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { TaskSchema } from "../openapi/task.schema.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["GitHub"];

const PrCheckSchema = z.object({ name: z.string(), state: z.string(), url: z.string().nullable() }).openapi("PrCheck");

const PrActionStateSchema = z
  .object({
    action: PrMenuAction,
    allowed: z.boolean().openapi({ description: "True exactly when `reason` is null" }),
    reason: z.string().nullable().openapi({ example: "a check is red", description: "Why it can't run, in words for a person; null when it can" }),
    needsClone: z.boolean().openapi({ description: "Off only for want of a checkout: a clone is all it needs" }),
  })
  .openapi("PrActionState");

export const PullRequestSchema = z
  .object({
    repo: z.string().openapi({ example: "acme/web", description: "`owner/name`" }),
    number: z.number(),
    title: z.string(),
    url: z.string(),
    author: z.string(),
    authorAssociation: z.string().nullable().optional().openapi({ description: "GitHub's `author_association` of the author; absent from a source that does not say" }),
    mine: z.boolean().openapi({ description: "You authored it" }),
    reviewRequested: z.boolean().openapi({ description: "Your review is requested, directly or through a team" }),
    isDraft: z.boolean(),
    headRef: z.string(),
    baseRef: z.string(),
    fromFork: z.boolean().openapi({ description: "The head lives in a fork: the machine cannot push to it" }),
    reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    mergeState: z.enum(["CLEAN", "HAS_HOOKS", "UNSTABLE", "BLOCKED", "BEHIND", "DIRTY", "DRAFT", "UNKNOWN"]).openapi({ description: "GitHub's own verdict on merging now" }),
    checks: z.object({ state: ChecksState, passed: z.number(), total: z.number(), failed: z.array(PrCheckSchema), all: z.array(PrCheckSchema) }),
    unresolvedThreads: z.number(),
    split: PrSplit,
    localPath: z.string().nullable().openapi({ description: "The checkout the machine would act in; null means read-only until cloned" }),
    task: z.object({ id: z.string(), state: z.string(), route: PrAction }).nullable().openapi({ description: "The PR task in flight for this PR, if any" }),
    updatedAt: z.string(),
    createdAt: z.string().openapi({ description: "When it was opened; its last update for a source that does not say" }),
    reviewRequestedAt: z.string().nullable().openapi({ description: "When your review (or a team's you are in) was last asked; null when it was not" }),
    threadsComplete: z.boolean().openapi({ description: "Every review thread was read; false when GitHub counts more than the query listed" }),
    actions: z.array(PrActionStateSchema).openapi({ description: "Each menu action in its order (ci_fix, address, review, merge, close) and why it can't run" }),
    headSha: z.string().nullable(),
    headCommittedAt: z.string().nullable(),
    nodeId: z.string().nullable(),
    body: z.string().nullable(),
  })
  .openapi("PullRequest");
expectSame<Same<z.infer<typeof PullRequestSchema>, PullRequest>>();

const CloneStatusSchema = z
  .object({
    repo: z.string(),
    dest: z.string(),
    state: z.enum(["cloning", "done", "failed"]),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi("CloneStatus");
expectSame<Same<z.infer<typeof CloneStatusSchema>, CloneStatus>>();

export const PrSnapshotSchema = z
  .object({
    prs: z.array(PullRequestSchema),
    polledAt: z.string().nullable(),
    error: z.string().nullable(),
    clones: z.array(CloneStatusSchema).optional(),
    digest: z.string().nullable().optional().openapi({ example: "2 PRs are waiting for your review · 1 is ready to merge", description: "One line of what waits on you; null when nothing does. The inbox only" }),
  })
  .openapi("PrSnapshot");
expectSame<Same<z.infer<typeof PrSnapshotSchema>, PrSnapshot>>();

export const PrActivitySchema = z
  .object({
    kind: PrActivityKind,
    repo: z.string().openapi({ example: "acme/web", description: "`owner/name`" }),
    number: z.number(),
    title: z.string(),
    url: z.string(),
    at: z.string().openapi({ description: "When the poll that saw it ended" }),
  })
  .openapi("PrActivity");
expectSame<Same<z.infer<typeof PrActivitySchema>, PrActivity>>();

const PrParams = z.object({
  owner: z.string().openapi({ param: { name: "owner", in: "path" }, example: "acme" }),
  name: z.string().openapi({ param: { name: "name", in: "path" }, example: "web" }),
  number: z.string().openapi({ param: { name: "number", in: "path" }, example: "42", description: "A positive integer" }),
});

export const prsRoute = createRoute({
  operationId: "listPullRequests",
  method: "get",
  path: "/github/prs",
  tags: TAGS,
  summary: "The PR inbox",
  description: "Every open PR involving you, as the machine last polled it.",
  responses: { 200: jsonContent(PrSnapshotSchema, "The inbox"), ...errorResponses() },
});

export const refreshPrsRoute = createRoute({
  operationId: "refreshPullRequests",
  method: "post",
  path: "/github/prs/refresh",
  tags: TAGS,
  summary: "Poll GitHub now",
  responses: { 200: jsonContent(PrSnapshotSchema, "The fresh snapshot"), ...errorResponses(429, 502) },
});

export const allPrsRoute = createRoute({
  operationId: "listAllPullRequests",
  method: "get",
  path: "/github/prs/all",
  tags: TAGS,
  summary: "Every open PR you can reach",
  description: "Every open PR in the repos you own, collaborate on or belong to through an organisation, as last polled on its own slower interval.",
  responses: { 200: jsonContent(PrSnapshotSchema, "The all-list"), ...errorResponses() },
});

export const refreshAllPrsRoute = createRoute({
  operationId: "refreshAllPullRequests",
  method: "post",
  path: "/github/prs/all/refresh",
  tags: TAGS,
  summary: "Start a poll of the all-list",
  description: "Starts a poll in the background (none when one is running) and answers 202 with the list as it stands; the fresh list arrives as a `github.prs.all` event.",
  responses: { 202: jsonContent(PrSnapshotSchema, "The list as it stands"), ...errorResponses() },
});

export const mergePrRoute = createRoute({
  operationId: "mergePullRequest",
  method: "post",
  path: "/github/prs/{owner}/{name}/{number}/merge",
  tags: TAGS,
  summary: "Merge a PR",
  description: "Merges the PR the way its repo allows (squash, else a merge commit, else a rebase) and deletes its branch; 409 `not_ready` unless its split is `ready_to_merge`.",
  request: { params: PrParams },
  responses: { 200: jsonContent(z.object({ merged: z.literal(true) }), "Merged"), ...errorResponses(400, 404, 409, 429, 502) },
});

export const closePrRoute = createRoute({
  operationId: "closePullRequest",
  method: "post",
  path: "/github/prs/{owner}/{name}/{number}/close",
  tags: TAGS,
  summary: "Close a PR without merging",
  description: "Closes the PR; its branch stays. 409 `pr_busy` while a PR task runs for it, 404 `no_pull` for a PR not in the inbox.",
  request: { params: PrParams },
  responses: { 200: jsonContent(z.object({ closed: z.literal(true) }), "Closed"), ...errorResponses(400, 404, 409, 429, 502) },
});

export const prActionRoute = createRoute({
  operationId: "runPullRequestAction",
  method: "post",
  path: "/github/prs/{owner}/{name}/{number}/actions",
  tags: TAGS,
  summary: "Run a PR task on a PR",
  description: "Creates and starts a PR task (`ci_fix`, `review`, `address`) on the PR's own head branch. 409 `pr_busy` while a task runs for the PR, `no_checkout` without a clone, `fork` for a fix or an address on a fork head, `own_pr` for a review of your own PR.",
  request: { params: PrParams, ...jsonBody(PrActionInput) },
  responses: { 201: jsonContent(TaskSchema, "The PR task"), ...errorResponses(400, 404, 409, 422, 429, 502, 503) },
});

export const cloneRoute = createRoute({
  operationId: "cloneRepository",
  method: "post",
  path: "/github/clone",
  tags: TAGS,
  summary: "Clone a repo the machine has no checkout of",
  description: "Clones in the background (202); the next `github.prs` and `github.prs.all` events show the checkout. 400 for a relative `dest`, a missing parent or an existing target.",
  request: jsonBody(CloneInput),
  responses: { 202: jsonContent(z.object({ repo: z.string(), dest: z.string(), cloning: z.literal(true) }), "The clone started"), ...errorResponses(400) },
});

const PrFactsSchema = PullRequestSchema.omit({ split: true, localPath: true, task: true, actions: true }).openapi("PrFacts");
expectSame<Same<z.infer<typeof PrFactsSchema>, PrFacts>>();

const PrDetailSchema = z
  .object({
    repo: z.string().openapi({ example: "acme/web", description: "`owner/name`" }),
    number: z.number(),
    state: z.enum(["open", "closed", "merged"]),
    facts: PrFactsSchema,
    threads: z.array(
      z.object({
        id: z.string(),
        path: z.string().nullable(),
        line: z.number().nullable().openapi({ description: "Null once the code has moved on" }),
        resolved: z.boolean(),
        outdated: z.boolean(),
        comments: z.array(z.object({ author: z.string(), body: z.string(), at: z.string() })),
      }),
    ),
    reviews: z.array(z.object({ author: z.string().nullable(), state: z.string(), at: z.string() })),
    files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number(), previousPath: z.string().optional() })),
  })
  .openapi("PrDetail");
expectSame<Same<z.infer<typeof PrDetailSchema>, PrDetail>>();

const PrLinkSchema = z.object({ url: z.string(), number: z.number(), isDraft: z.boolean() }).openapi("PrLink");
expectSame<Same<z.infer<typeof PrLinkSchema>, PrLink>>();

const IssueHitSchema = z
  .object({ number: z.number(), title: z.string(), url: z.string(), state: z.enum(["open", "closed"]), author: z.string().nullable() })
  .openapi("IssueHit");
expectSame<Same<z.infer<typeof IssueHitSchema>, IssueHit>>();

const Repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name");

export const prDetailRoute = createRoute({
  operationId: "getPullRequest",
  method: "get",
  path: "/github/prs/{owner}/{name}/{number}",
  tags: TAGS,
  summary: "One PR read now, for a client's PR tab",
  description: "Its facts (checks, review, merge state), whether it is open, closed or merged, every review thread (resolved ones too), the reviews and the files. Read from GitHub on each call, as the repository's account; never cached. 404 `no_pull` when GitHub no longer shows it.",
  request: { params: PrParams },
  responses: { 200: jsonContent(PrDetailSchema, "The PR"), ...errorResponses(400, 404, 429, 502) },
});

export const readyPrRoute = createRoute({
  operationId: "markPullRequestReady",
  method: "post",
  path: "/github/prs/{owner}/{name}/{number}/ready",
  tags: TAGS,
  summary: "Mark a draft PR ready for review",
  description: "Only from a person's click in a client. The inbox polls again after, so the next `github.prs` event shows it.",
  request: { params: PrParams },
  responses: { 200: jsonContent(z.object({ ready: z.literal(true) }), "Ready for review"), ...errorResponses(400, 404, 429, 502) },
});

export const lookupPrRoute = createRoute({
  operationId: "lookupPullRequest",
  method: "get",
  path: "/github/prs/lookup",
  tags: TAGS,
  summary: "The open PR of a branch",
  request: {
    query: z.object({
      repo: Repo.openapi({ example: "acme/web" }),
      branch: z.string().min(1).max(255).openapi({ example: "feat/export" }),
    }),
  },
  responses: { 200: jsonContent(z.object({ pr: PrLinkSchema.nullable() }), "The PR, or null when the branch has none open"), ...errorResponses(400, 429, 502) },
});

export const searchIssuesRoute = createRoute({
  operationId: "searchIssues",
  method: "get",
  path: "/github/search",
  tags: TAGS,
  summary: "Search a repository's PRs or issues",
  description: "Twenty at most, most recently updated first; for a client's @-mentions. The words are GitHub's search syntax, held to the one repository and kind.",
  request: {
    query: z.object({
      repo: Repo.openapi({ example: "acme/web" }),
      kind: IssueKind,
      q: z.string().max(256).default("").openapi({ example: "crash" }),
    }),
  },
  responses: { 200: jsonContent(z.object({ items: z.array(IssueHitSchema) }), "What matched"), ...errorResponses(400, 429, 502) },
});

export const openPrRoute = createRoute({
  operationId: "openPullRequest",
  method: "post",
  path: "/github/pr",
  tags: TAGS,
  summary: "Push a branch and open its PR",
  description: "Pushes `branch` from the checkout at `path` and opens its PR on the checkout's origin (or answers the one already open). Only from a person's click. 400 `outside_repos` for a folder outside the repositories folder the machine sees (`reposDir` on `/health`), 422 `push_failed` in git's words.",
  request: jsonBody(OpenPrInput),
  responses: { 201: jsonContent(PrLinkSchema, "The PR"), ...errorResponses(400, 422, 429, 502) },
});
