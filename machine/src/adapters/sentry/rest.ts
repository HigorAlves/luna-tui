// The Sentry port over the REST API with plain `fetch`: a bearer token against
// `<url>/api/0/organizations/<org>/issues/`, JSON both ways, pages followed through the `Link` header. A 401/403 is a
// `SentryAuthError`, a 429 a `SentryError` that says it is rate limited and not retried here: the caller backs off.
import { z } from "zod";

import { type Listing, type Sentry, SentryAuthError, SentryError, type SentryIssue } from "../../application/sentry.ts";

export interface SentryRestOptions {
  token: string;
  /** The organization's slug. */
  org: string;
  /** Narrow to these project slugs; empty or unset reads every project. */
  projects?: string[];
  /** `https://sentry.io`, or a self-hosted address. */
  url?: string;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  /** The window ends now; tests fix it. */
  now?: () => Date;
}

/** The most issues one page asks for. */
export const ISSUE_PAGE = 100;
/** The most pages one listing follows before it reports itself incomplete. */
export const MAX_PAGES = 10;

const Issues = z.array(
  z.object({
    id: z.string(),
    shortId: z.string(),
    title: z.string(),
    culprit: z.string().nullish(),
    level: z.string(),
    status: z.string(),
    // Sentry sends the event count as a string.
    count: z.union([z.string(), z.number()]),
    userCount: z.number(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    permalink: z.string(),
    project: z.object({ slug: z.string() }),
  }),
);

/** The cursor of the `rel="next"` link when it has results, else null. */
function nextCursor(link: string | null): string | null {
  for (const part of (link ?? "").split(/,\s*(?=<)/)) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    return /cursor="([^"]+)"/.exec(part)?.[1] ?? null;
  }
  return null;
}

export function createSentry(options: SentryRestOptions): Sentry {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const base = (options.url ?? "https://sentry.io").replace(/\/+$/, "");
  const path = `api/0/organizations/${encodeURIComponent(options.org)}/issues/`;

  /** One search, every page up to the cap. */
  async function search(query: string, start: number): Promise<Listing<SentryIssue>> {
    const found: Listing<SentryIssue> = [];
    let cursor: string | null = null;
    for (let pages = 0; ; pages++) {
      const url = new URL(`${base}/${path}`);
      url.searchParams.set("query", query);
      url.searchParams.set("start", new Date(start).toISOString());
      url.searchParams.set("end", now().toISOString());
      url.searchParams.set("sort", "date");
      url.searchParams.set("limit", String(ISSUE_PAGE));
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      let response: Response;
      try {
        response = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" } });
      } catch (error) {
        throw new SentryError(`GET ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const text = await response.text();
      if (response.status === 401) throw new SentryAuthError(`Sentry rejected the token on GET ${path}: it is wrong or revoked`, 401);
      if (response.status === 403) {
        throw new SentryAuthError(`Sentry refused GET ${path}: the token lacks a scope (it needs event:read, project:read and org:read) or cannot see the organization`, 403);
      }
      if (response.status === 429) {
        const retry = Number(response.headers.get("Retry-After"));
        throw new SentryError(`Sentry rate limited GET ${path}${Number.isFinite(retry) && retry > 0 ? `: retry after ${retry}s` : ""}`, 429);
      }
      if (!response.ok) throw new SentryError(`GET ${path}: HTTP ${response.status}`, response.status);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new SentryError(`GET ${path}: the answer was not JSON`, response.status);
      }
      const parsed = Issues.safeParse(body);
      if (!parsed.success) throw new SentryError(`GET ${path}: unexpected answer: ${z.prettifyError(parsed.error)}`, response.status);
      for (const issue of parsed.data) {
        found.push({
          id: issue.id,
          shortId: issue.shortId,
          title: issue.title,
          culprit: issue.culprit ?? "",
          level: issue.level,
          status: issue.status,
          count: Number(issue.count) || 0,
          userCount: issue.userCount,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
          permalink: issue.permalink,
          project: issue.project.slug,
        });
      }
      cursor = nextCursor(response.headers.get("Link"));
      if (cursor === null) break;
      if (pages + 1 >= MAX_PAGES) {
        found.incomplete = true;
        break;
      }
    }
    return found;
  }

  return {
    async newOrEscalatingIssues(since: string): Promise<Listing<SentryIssue>> {
      const start = Date.parse(since);
      if (Number.isNaN(start)) throw new SentryError(`GET ${path}: "${since}" is not a timestamp`);
      // Two plain queries, not one with OR: Sentry's issue search may reject a boolean OR. A project filter is repeated per
      // project, since the `project` parameter takes ids and a slug only works inside the query.
      const scopes = (options.projects ?? []).length > 0 ? (options.projects ?? []).map((p) => ` project:${p}`) : [""];
      const out: Listing<SentryIssue> = [];
      const seen = new Set<string>();
      for (const scope of scopes) {
        for (const query of [`is:unresolved firstSeen:>=${since}${scope}`, `is:unresolved is:escalating${scope}`]) {
          const listing = await search(query, start);
          if (listing.incomplete) out.incomplete = true;
          for (const issue of listing) {
            if (seen.has(issue.id)) continue;
            seen.add(issue.id);
            out.push(issue);
          }
        }
      }
      return out;
    },
  };
}
