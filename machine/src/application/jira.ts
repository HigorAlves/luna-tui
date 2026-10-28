// The Jira port: everything the machine asks Jira Cloud, as typed calls over one API token.
// The REST v3 adapter implements it; tests pass a fake. Every method throws a `JiraError`
// carrying Jira's own words when a call fails; a 401 is a `JiraAuthError` (the token was
// rejected or has expired), an unknown issue a `JiraNotFoundError`. Descriptions and comments
// cross the port as markdown: the adapter converts Atlassian Document Format both ways.

export class JiraError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the failure was an HTTP answer. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

/** Jira answered 401: the token was rejected or has expired. */
export class JiraAuthError extends JiraError {
  constructor(
    message: string,
    /** When Jira said the token expires, if it said. */
    readonly expiresAt: string | null = null,
  ) {
    super(message, 401);
    this.name = "JiraAuthError";
  }
}

/** No issue with that key, or none the token may see. */
export class JiraNotFoundError extends JiraError {
  constructor(readonly key: string) {
    super(`Jira has no issue ${key} (or the token cannot see it)`, 404);
    this.name = "JiraNotFoundError";
  }
}

/** Jira is not configured: `MACHINE_JIRA_SITE`, `MACHINE_JIRA_EMAIL` and `MACHINE_JIRA_TOKEN` are unset. */
export class NoJiraTokenError extends JiraError {
  constructor() {
    super("Jira is not configured: set MACHINE_JIRA_SITE, MACHINE_JIRA_EMAIL and MACHINE_JIRA_TOKEN");
    this.name = "NoJiraTokenError";
  }
}

export interface JiraMe {
  accountId: string;
  displayName: string;
  email: string | null;
}

/** One comment on an issue, oldest first in `JiraIssue.comments`. */
export interface JiraComment {
  author: string;
  /** The author's account id; null when Jira left it out. */
  authorId: string | null;
  /** The body as markdown. */
  text: string;
  created: string;
}

/** An issue as the machine reads it; `description` and the comments are markdown. */
export interface JiraIssue {
  key: string;
  url: string;
  summary: string;
  description: string;
  status: string | null;
  /** Jira's status category key: `new`, `indeterminate` or `done`. */
  statusCategory: string | null;
  issueType: string | null;
  priority: string | null;
  /** `YYYY-MM-DD` as Jira stores it; the machine reads it as a date. */
  dueAt: string | null;
  labels: string[];
  /** Jira's `updated` stamp, so intake can tell an issue that moved since it last asked. */
  updated: string | null;
  comments: JiraComment[];
}

/** A transition the issue can take right now. */
export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; categoryKey: string | null };
}

export interface JiraSearchPage {
  issues: JiraIssue[];
  nextPageToken: string | null;
}

export interface JiraStatusName {
  name: string;
  categoryKey: string | null;
}

export interface Jira {
  /** Who the token belongs to. */
  me(): Promise<JiraMe>;
  /** The issue with its description and comments as markdown. */
  issue(key: string): Promise<JiraIssue>;
  /** The transitions available from the issue's current status. */
  transitions(key: string): Promise<JiraTransition[]>;
  /** Performs one transition, setting `fields` on the way when given. */
  transition(key: string, id: string, fields?: Record<string, unknown>): Promise<void>;
  /** Posts a comment; `text` is markdown (paragraphs, `- ` bullets, bare urls). */
  comment(key: string, text: string): Promise<void>;
  /** Sets fields on the issue, e.g. `{ customfield_10045: "https://…" }`. */
  editFields(key: string, fields: Record<string, unknown>): Promise<void>;
  /** One page of a JQL search, newest-updated first as the JQL orders it. */
  search(jql: string, options?: { maxResults?: number; nextPageToken?: string | null }): Promise<JiraSearchPage>;
  /** Creates an issue; the description is markdown. */
  createIssue(project: string, issueType: string, summary: string, descriptionMarkdown: string): Promise<{ key: string; url: string }>;
  /** Every status name the project's workflows use. */
  statuses(projectKey: string): Promise<JiraStatusName[]>;
}

/** A Jira key like `PLAT-123`, as a whole token. */
export const JIRA_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/;

/** The first Jira key in a text, or null. */
export function findJiraKey(text: string): string | null {
  return JIRA_KEY.exec(text)?.[1] ?? null;
}

/** The issue's page on the site: `https://acme.atlassian.net/browse/PLAT-123`. */
export function issueUrl(site: string, key: string): string {
  return `${site.replace(/\/+$/, "")}/browse/${key}`;
}

/** The port with nothing behind it: every call fails with the same clear reason. */
export function noTokenJira(): Jira {
  const refuse = () => Promise.reject(new NoJiraTokenError());
  return {
    me: refuse,
    issue: refuse,
    transitions: refuse,
    transition: refuse,
    comment: refuse,
    editFields: refuse,
    search: refuse,
    createIssue: refuse,
    statuses: refuse,
  };
}

export { messageOf } from "./github.ts";
