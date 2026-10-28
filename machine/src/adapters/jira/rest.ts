// The Jira port over Jira Cloud's REST v3 with plain `fetch`: basic auth with your Atlassian
// email and API token, JSON both ways, ADF converted to and from markdown at the edge. A 429
// waits for `Retry-After` once, then gives up with a message the pollers recognise; a 401 is a
// `JiraAuthError` saying the token was rejected or expired, with the expiry when the answer
// names one. With `cloudId` set (a scoped token) calls go through api.atlassian.com instead
// of the site; the site is still where issue urls point.
import { z } from "zod";

import {
  type Jira,
  JiraAuthError,
  JiraError,
  type JiraIssue,
  JiraNotFoundError,
  type JiraSearchPage,
  type JiraTransition,
  issueUrl,
} from "../../application/jira.ts";
import { adfToMarkdown, markdownToAdf } from "./adf.ts";

export interface JiraRestOptions {
  site: string;
  email: string;
  token: string;
  /** For a scoped API token: calls go to `https://api.atlassian.com/ex/jira/<cloudId>`. */
  cloudId?: string | null;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  /** Waits for a 429's `Retry-After`; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** The fields every issue read asks for; `comment` brings the comments along. */
export const ISSUE_FIELDS = ["summary", "description", "status", "issuetype", "priority", "duedate", "labels", "updated", "comment"];
/** The most issues one search page asks for. */
export const SEARCH_PAGE = 50;

const Named = z.object({ name: z.string().optional() }).passthrough();
const Status = z.object({ name: z.string().optional(), statusCategory: z.object({ key: z.string().optional() }).optional() }).passthrough();
const Comment = z.object({
  author: z.object({ accountId: z.string().optional(), displayName: z.string().optional() }).optional(),
  body: z.unknown().optional(),
  created: z.string().optional(),
});
const Fields = z
  .object({
    summary: z.string().optional().nullable(),
    description: z.unknown().optional(),
    status: Status.optional().nullable(),
    issuetype: Named.optional().nullable(),
    priority: Named.optional().nullable(),
    duedate: z.string().optional().nullable(),
    labels: z.array(z.string()).optional(),
    updated: z.string().optional().nullable(),
    comment: z.object({ comments: z.array(Comment) }).optional().nullable(),
  })
  .passthrough();
const Issue = z.object({ key: z.string(), fields: Fields });
const Transitions = z.object({ transitions: z.array(z.object({ id: z.string(), name: z.string(), to: Status.optional() })) });
const SearchResults = z.object({ issues: z.array(Issue).default([]), nextPageToken: z.string().optional().nullable() });
const Created = z.object({ key: z.string() });
const Me = z.object({ accountId: z.string(), displayName: z.string().default(""), emailAddress: z.string().optional().nullable() });
const ProjectStatuses = z.array(z.object({ statuses: z.array(Status).default([]) }));
const ErrorBody = z.object({ errorMessages: z.array(z.string()).optional(), errors: z.record(z.string(), z.string()).optional() }).partial();

const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/;

/** Jira's error words from an answer's body, or the status alone. */
function describe(status: number, body: string): string {
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(body));
    if (parsed.success) {
      const words = [...(parsed.data.errorMessages ?? []), ...Object.entries(parsed.data.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
      if (words.length > 0) return words.join("; ");
    }
  } catch {
    // not JSON
  }
  return `HTTP ${status}`;
}

function toIssue(site: string, raw: z.infer<typeof Issue>): JiraIssue {
  const f = raw.fields;
  return {
    key: raw.key,
    url: issueUrl(site, raw.key),
    summary: f.summary ?? "",
    description: adfToMarkdown(f.description),
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.key ?? null,
    issueType: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    dueAt: f.duedate ?? null,
    labels: f.labels ?? [],
    updated: f.updated ?? null,
    comments: (f.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? "someone",
      authorId: c.author?.accountId ?? null,
      text: adfToMarkdown(c.body),
      created: c.created ?? "",
    })),
  };
}

export function createJira(options: JiraRestOptions): Jira {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const site = options.site.replace(/\/+$/, "");
  const base = options.cloudId ? `https://api.atlassian.com/ex/jira/${options.cloudId}` : site;
  const auth = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;

  async function call<T extends z.ZodType>(method: string, path: string, shape: T | null, body?: unknown, query?: Record<string, string>): Promise<z.infer<T>> {
    const url = new URL(`${base}/rest/api/3/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const request = (): Promise<Response> =>
      doFetch(url.toString(), {
        method,
        headers: { Authorization: auth, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let response = await request();
    if (response.status === 429) {
      const after = Number(response.headers.get("Retry-After") ?? "1");
      await sleep((Number.isFinite(after) ? after : 1) * 1000);
      response = await request();
      if (response.status === 429) throw new JiraError(`Jira rate limit on ${method} ${path}: retry after ${after}s`, 429);
    }
    const text = await response.text();
    if (response.status === 401) {
      const hint = response.headers.get("X-Token-Expires-At") ?? ISO_DATE.exec(text)?.[0] ?? null;
      throw new JiraAuthError(`Jira rejected the token on ${method} ${path} (expired or revoked): ${describe(401, text)}`, hint);
    }
    if (response.status === 404) throw new JiraError(`${method} ${path}: ${describe(404, text)}`, 404);
    if (!response.ok) throw new JiraError(`${method} ${path}: ${describe(response.status, text)}`, response.status);
    if (!shape) return undefined as z.infer<T>;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new JiraError(`${method} ${path}: the answer was not JSON`, response.status);
    }
    const parsed = shape.safeParse(json);
    if (!parsed.success) throw new JiraError(`${method} ${path}: unexpected answer: ${z.prettifyError(parsed.error)}`, response.status);
    return parsed.data;
  }

  const notFound = (key: string) => (error: unknown) => {
    if (error instanceof JiraError && error.status === 404) throw new JiraNotFoundError(key);
    throw error;
  };

  return {
    async me() {
      const a = await call("GET", "myself", Me);
      return { accountId: a.accountId, displayName: a.displayName, email: a.emailAddress ?? null };
    },

    async issue(key) {
      const a = await call("GET", `issue/${encodeURIComponent(key)}`, Issue, undefined, { fields: ISSUE_FIELDS.join(",") }).catch(notFound(key));
      return toIssue(site, a);
    },

    async transitions(key) {
      const a = await call("GET", `issue/${encodeURIComponent(key)}/transitions`, Transitions).catch(notFound(key));
      return a.transitions.map(
        (t): JiraTransition => ({ id: t.id, name: t.name, to: { name: t.to?.name ?? t.name, categoryKey: t.to?.statusCategory?.key ?? null } }),
      );
    },

    async transition(key, id, fields) {
      await call("POST", `issue/${encodeURIComponent(key)}/transitions`, null, { transition: { id }, ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) }).catch(notFound(key));
    },

    async comment(key, text) {
      await call("POST", `issue/${encodeURIComponent(key)}/comment`, null, { body: markdownToAdf(text) }).catch(notFound(key));
    },

    async editFields(key, fields) {
      await call("PUT", `issue/${encodeURIComponent(key)}`, null, { fields }).catch(notFound(key));
    },

    async search(jql, opts = {}) {
      const a = await call("POST", "search/jql", SearchResults, {
        jql,
        maxResults: opts.maxResults ?? SEARCH_PAGE,
        fields: ISSUE_FIELDS,
        ...(opts.nextPageToken ? { nextPageToken: opts.nextPageToken } : {}),
      });
      return { issues: a.issues.map((i) => toIssue(site, i)), nextPageToken: a.nextPageToken || null } satisfies JiraSearchPage;
    },

    async createIssue(project, issueType, summary, descriptionMarkdown) {
      const a = await call("POST", "issue", Created, {
        fields: { project: { key: project }, issuetype: { name: issueType }, summary, description: markdownToAdf(descriptionMarkdown) },
      });
      return { key: a.key, url: issueUrl(site, a.key) };
    },

    async statuses(projectKey) {
      const a = await call("GET", `project/${encodeURIComponent(projectKey)}/statuses`, ProjectStatuses);
      const seen = new Map<string, string | null>();
      for (const type of a) for (const s of type.statuses) if (s.name && !seen.has(s.name)) seen.set(s.name, s.statusCategory?.key ?? null);
      return [...seen].map(([name, categoryKey]) => ({ name, categoryKey }));
    },
  };
}
