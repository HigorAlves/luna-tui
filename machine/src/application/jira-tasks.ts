// What the board does with Jira by hand, behind the `/jira/*` and `/tasks/:id/jira*` routes:
// link a ticket to an issue (checking it exists), unlink it, create an issue from the ticket,
// search issues to pick from, and say whether Jira is reachable. JiraSync, JiraIntake and
// JiraWatch do the automatic part; this is the `J` key.
import type { JiraCreateInput, JiraIssueHit, JiraLink, JiraStatus } from "@hardness/contracts";

import { bareLink, jiraOf } from "../domain/jira-link.ts";
import type { TaskRow } from "../domain/task.ts";
import type { Policy } from "../domain/policy.ts";
import { JIRA_KEY, type Jira, JiraAuthError, type JiraIssue, JiraNotFoundError, messageOf } from "./jira.ts";

/** `POST /tasks/:id/jira` named an issue Jira does not have: 404 `no_issue`. */
export class NoIssueError extends Error {
  constructor(key: string) {
    super(`Jira has no issue ${key}`);
    this.name = "NoIssueError";
  }
}

/** `POST /tasks/:id/jira/create` on a ticket that already carries an issue: 409 `already_linked`. */
export class AlreadyLinkedError extends Error {
  constructor(taskId: string, key: string) {
    super(`task ${taskId} is already linked to ${key}`);
    this.name = "AlreadyLinkedError";
  }
}

/** Creating an issue with no project named by the request or the repo's luna.yaml: 409 `no_project`. */
export class NoProjectError extends Error {
  constructor() {
    super("no Jira project: pass one, or set jira.project in the repo's luna.yaml");
    this.name = "NoProjectError";
  }
}

/** What the routes need; the real class and a test fake both fit. */
export interface JiraTasksPort {
  status(): Promise<JiraStatus>;
  search(q: string): Promise<JiraIssueHit[]>;
  link(taskId: string, key: string): Promise<TaskRow>;
  unlink(taskId: string): Promise<TaskRow>;
  create(taskId: string, input: JiraCreateInput): Promise<TaskRow>;
}

/** Remembers the token expiry Jira last named on a 401, for `GET /jira/status` and the daily warning. */
export class TokenExpiry {
  at: string | null = null;

  /** Notes the expiry from an auth error, when it carries one. */
  note(error: unknown): void {
    if (error instanceof JiraAuthError && error.expiresAt) this.at = error.expiresAt;
  }
}

export interface JiraTasksOptions {
  jira: Jira;
  /** Null when Jira is not configured: status says so and every other call fails as the port does. */
  site: string | null;
  pipeline: {
    get(id: string): Promise<TaskRow>;
    setJira(id: string, link: JiraLink | null): Promise<TaskRow>;
    record(id: string, kind: string, payload: Record<string, unknown>): Promise<void>;
    policyFor(repoPath: string | null): Promise<Policy>;
  };
  expiry?: TokenExpiry;
  now?: () => Date;
}

/** The most hits a search answers. */
export const SEARCH_MAX = 15;
const DEFAULT_ISSUE_TYPE = "Task";

/** The link for an issue as Jira shows it now. */
export function linkOf(issue: JiraIssue, now: Date): JiraLink {
  return { ...bareLink(issue.key, issue.url, issue.issueType), status: issue.status, priority: issue.priority, dueAt: issue.dueAt, syncedAt: now.toISOString() };
}

const hit = (issue: JiraIssue): JiraIssueHit => ({ key: issue.key, summary: issue.summary, status: issue.status, issueType: issue.issueType, url: issue.url });

/** The markdown an issue created from a ticket carries: the description, then the criteria as a checklist. */
export function issueDescription(task: Pick<TaskRow, "description" | "criteria">): string {
  const parts = [task.description.trim()].filter(Boolean);
  if (task.criteria.length > 0) parts.push(`## Criteria\n${task.criteria.map((c) => `- [ ] ${c}`).join("\n")}`);
  return parts.join("\n\n");
}

export class JiraTasks implements JiraTasksPort {
  private readonly expiry: TokenExpiry;
  private readonly now: () => Date;

  constructor(private readonly options: JiraTasksOptions) {
    this.expiry = options.expiry ?? new TokenExpiry();
    this.now = options.now ?? (() => new Date());
  }

  async status(): Promise<JiraStatus> {
    if (!this.options.site) return { configured: false, site: null, tokenExpiresAt: null, error: null };
    try {
      await this.options.jira.me();
      return { configured: true, site: this.options.site, tokenExpiresAt: this.expiry.at, error: null };
    } catch (error) {
      this.expiry.note(error);
      return { configured: true, site: this.options.site, tokenExpiresAt: this.expiry.at, error: messageOf(error) };
    }
  }

  /** A key answers that issue; text searches `text ~ "q"`, your open issues first, at most 15. */
  async search(q: string): Promise<JiraIssueHit[]> {
    const query = q.trim();
    if (query === "") return [];
    if (new RegExp(`^${JIRA_KEY.source.slice(2, -2)}$`, "i").test(query)) {
      try {
        return [hit(await this.options.jira.issue(query.toUpperCase()))];
      } catch (error) {
        if (error instanceof JiraNotFoundError) return [];
        throw error;
      }
    }
    const text = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const mine = await this.options.jira.search(`text ~ "${text}" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, { maxResults: SEARCH_MAX });
    const hits = new Map(mine.issues.map((i) => [i.key, hit(i)]));
    if (hits.size < SEARCH_MAX) {
      const all = await this.options.jira.search(`text ~ "${text}" ORDER BY updated DESC`, { maxResults: SEARCH_MAX });
      for (const issue of all.issues) if (!hits.has(issue.key) && hits.size < SEARCH_MAX) hits.set(issue.key, hit(issue));
    }
    return [...hits.values()];
  }

  async link(taskId: string, key: string): Promise<TaskRow> {
    await this.options.pipeline.get(taskId);
    let issue: JiraIssue;
    try {
      issue = await this.options.jira.issue(key);
    } catch (error) {
      if (error instanceof JiraNotFoundError) throw new NoIssueError(key);
      throw error;
    }
    const task = await this.options.pipeline.setJira(taskId, linkOf(issue, this.now()));
    await this.options.pipeline.record(taskId, "jira.linked", { key: issue.key, url: issue.url });
    return task;
  }

  async unlink(taskId: string): Promise<TaskRow> {
    const before = await this.options.pipeline.get(taskId);
    const task = await this.options.pipeline.setJira(taskId, null);
    const key = jiraOf(before)?.key;
    if (key) await this.options.pipeline.record(taskId, "jira.unlinked", { key });
    return task;
  }

  async create(taskId: string, input: JiraCreateInput): Promise<TaskRow> {
    const task = await this.options.pipeline.get(taskId);
    const linked = jiraOf(task);
    if (linked) throw new AlreadyLinkedError(taskId, linked.key);
    const policy = await this.options.pipeline.policyFor(task.repoPath);
    const project = input.project ?? policy.jira?.project ?? null;
    if (!project) throw new NoProjectError();
    const issueType = input.issueType ?? DEFAULT_ISSUE_TYPE;
    const created = await this.options.jira.createIssue(project, issueType, task.title, issueDescription(task));
    const after = await this.options.pipeline.setJira(taskId, { ...bareLink(created.key, created.url, issueType), syncedAt: this.now().toISOString() });
    await this.options.pipeline.record(taskId, "jira.linked", { key: created.key, url: created.url, created: true });
    return after;
  }
}
