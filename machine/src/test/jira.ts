// A fake Jira port for tests: a handful of issues in memory, the transitions each status
// allows, and a record of every write. Reads answer from memory; writes change it.
import { type Jira, type JiraIssue, JiraNotFoundError, type JiraTransition } from "../application/jira.ts";

export interface FakeJiraOptions {
  site?: string;
  issues?: Array<Partial<JiraIssue> & { key: string }>;
  /** Per current status, the transitions available (the fake moves the issue to `to.name`). */
  transitions?: Record<string, JiraTransition[]>;
  /** Makes a call fail: the method name to the error it throws. */
  failing?: Partial<Record<keyof Jira, Error>>;
  me?: { accountId: string; displayName: string; email: string | null };
}

export interface FakeJira extends Jira {
  issues: Map<string, JiraIssue>;
  /** Every write, as `[method, ...args]`. */
  writes: unknown[][];
  /** Comments posted, by key, oldest first, as markdown. */
  comments: Record<string, string[]>;
  /** Every search, as the JQL asked. */
  searches: string[];
  /** The next search answers these keys (then every issue). */
  searchHits: string[] | null;
  nextKey: number;
}

export const SITE = "https://acme.atlassian.net";

export function issueOf(over: Partial<JiraIssue> & { key: string }, site = SITE): JiraIssue {
  return {
    url: `${site}/browse/${over.key}`,
    summary: `Issue ${over.key}`,
    description: "",
    status: "To Do",
    statusCategory: "new",
    issueType: "Story",
    priority: "Medium",
    dueAt: null,
    labels: [],
    updated: "2026-10-28T10:00:00.000+0000",
    comments: [],
    ...over,
  };
}

export function fakeJira(options: FakeJiraOptions = {}): FakeJira {
  const site = options.site ?? SITE;
  const issues = new Map((options.issues ?? []).map((i) => [i.key, issueOf(i, site)]));
  const transitions = options.transitions ?? {};
  const failing = options.failing ?? {};
  const fail = (method: keyof Jira) => {
    const error = failing[method];
    if (error) throw error;
  };
  const find = (key: string): JiraIssue => {
    const issue = issues.get(key);
    if (!issue) throw new JiraNotFoundError(key);
    return issue;
  };
  const fake: FakeJira = {
    issues,
    writes: [],
    comments: {},
    searches: [],
    searchHits: null,
    nextKey: 500,
    async me() {
      fail("me");
      return options.me ?? { accountId: "A-ME", displayName: "Higor", email: "me@acme.com" };
    },
    async issue(key) {
      fail("issue");
      return structuredClone(find(key));
    },
    async transitions(key) {
      fail("transitions");
      const issue = find(key);
      return transitions[issue.status ?? ""] ?? [];
    },
    async transition(key, id, fields) {
      fail("transition");
      const issue = find(key);
      const available = transitions[issue.status ?? ""] ?? [];
      const t = available.find((x) => x.id === id);
      if (!t) throw new Error(`transition ${id} is not available from ${issue.status}`);
      issue.status = t.to.name;
      issue.statusCategory = t.to.categoryKey;
      fake.writes.push(["transition", key, id, fields ?? null]);
    },
    async comment(key, text) {
      fail("comment");
      find(key);
      fake.writes.push(["comment", key, text]);
      (fake.comments[key] ??= []).push(text);
    },
    async editFields(key, fields) {
      fail("editFields");
      find(key);
      fake.writes.push(["editFields", key, fields]);
    },
    async search(jql, opts = {}) {
      fail("search");
      fake.searches.push(jql);
      const keys = fake.searchHits ?? [...issues.keys()];
      fake.searchHits = null;
      const max = opts.maxResults ?? 50;
      return { issues: keys.slice(0, max).map((k) => structuredClone(find(k))), nextPageToken: null };
    },
    async createIssue(project, issueType, summary, description) {
      fail("createIssue");
      const key = `${project}-${fake.nextKey++}`;
      issues.set(key, issueOf({ key, summary, description, issueType }, site));
      fake.writes.push(["createIssue", project, issueType, summary, description]);
      return { key, url: `${site}/browse/${key}` };
    },
    async statuses() {
      fail("statuses");
      return [...new Set(Object.values(transitions).flat().map((t) => t.to.name))].map((name) => ({ name, categoryKey: null }));
    },
  };
  return fake;
}

/** The usual workflow: To Do → In Progress → In Review → Done, Blocked from In Progress and back. */
export const WORKFLOW: Record<string, JiraTransition[]> = {
  "To Do": [{ id: "11", name: "Start", to: { name: "In Progress", categoryKey: "indeterminate" } }],
  "In Progress": [
    { id: "21", name: "Review", to: { name: "In Review", categoryKey: "indeterminate" } },
    { id: "22", name: "Block", to: { name: "Blocked", categoryKey: "indeterminate" } },
  ],
  Blocked: [{ id: "31", name: "Unblock", to: { name: "In Progress", categoryKey: "indeterminate" } }],
  "In Review": [{ id: "41", name: "Finish", to: { name: "Done", categoryKey: "done" } }],
  Done: [],
};
