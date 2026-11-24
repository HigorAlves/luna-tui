// OpenAPI route definitions of Jira by hand (`J` on a ticket): the status, the search, and link, unlink and create on a task.
import { JiraCreateInput, JiraLinkInput, type JiraIssueHit, type JiraStatus } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, expectSame, jsonBody, jsonContent, type Same, TaskIdParams } from "../openapi/schemas.ts";
import { TaskSchema } from "../openapi/task.schema.ts";

const TAGS = ["Jira"];

export const JiraStatusSchema = z
  .object({
    configured: z.boolean(),
    site: z.string().nullable().openapi({ example: "https://acme.atlassian.net" }),
    tokenExpiresAt: z.string().nullable().openapi({ description: "When the token expires: `MACHINE_JIRA_TOKEN_EXPIRES` as set, or the date a 401 named once it has gone" }),
    error: z.string().nullable(),
  })
  .openapi("JiraStatus");
expectSame<Same<z.infer<typeof JiraStatusSchema>, JiraStatus>>();

export const JiraIssueHitSchema = z
  .object({
    key: z.string().openapi({ example: "PLAT-123" }),
    summary: z.string(),
    status: z.string().nullable(),
    issueType: z.string().nullable(),
    url: z.string(),
  })
  .openapi("JiraIssueHit");
expectSame<Same<z.infer<typeof JiraIssueHitSchema>, JiraIssueHit>>();

export const jiraStatusRoute = createRoute({
  method: "get",
  path: "/jira/status",
  tags: TAGS,
  summary: "Whether Jira is configured and reachable",
  description: "The site, when the token expires and the last error. These routes exist only on a machine with Jira wired.",
  responses: { 200: jsonContent(JiraStatusSchema, "Jira's status"), ...errorResponses() },
});

export const jiraSearchRoute = createRoute({
  method: "get",
  path: "/jira/search",
  tags: TAGS,
  summary: "Search issues to pick from",
  description: "A key or free text; your open issues first. An empty `q` finds nothing. 409 `no_token` when the machine has no Jira token.",
  request: { query: z.object({ q: z.string().optional().openapi({ example: "login", description: "A Jira key or free text" }) }) },
  responses: { 200: jsonContent(z.array(JiraIssueHitSchema), "The matching issues"), ...errorResponses(409) },
});

export const linkJiraRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/jira",
  tags: TAGS,
  summary: "Link an existing issue to a task",
  description: "Checks the issue exists (404 `no_issue`). 409: `already_linked_elsewhere` (another open task holds it), `has_worktree` (the branch was named from the link), `notch_task`, `no_token`.",
  request: { params: TaskIdParams, ...jsonBody(JiraLinkInput) },
  responses: { 200: jsonContent(TaskSchema, "The task, linked"), ...errorResponses(400, 404, 409) },
});

export const unlinkJiraRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}/jira",
  tags: TAGS,
  summary: "Unlink a task's issue",
  description: "409: `has_worktree` (the task already works on a branch named from the link), `notch_task`, `no_token`.",
  request: { params: TaskIdParams },
  responses: { 200: jsonContent(TaskSchema, "The task, unlinked"), ...errorResponses(404, 409) },
});

export const createJiraRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/jira/create",
  tags: TAGS,
  summary: "Create an issue from a task",
  description: "Creates an issue in the repo's project (or `project`) and links it. 409: `already_linked`, `no_project`, `has_worktree`, `notch_task`, `no_token`.",
  request: { params: TaskIdParams, ...jsonBody(JiraCreateInput) },
  responses: { 201: jsonContent(TaskSchema, "The task, with the new issue linked"), ...errorResponses(400, 404, 409) },
});
