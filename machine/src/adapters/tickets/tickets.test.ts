import { describe, expect, it, vi } from "vitest";

import type { GitHub, GhIssue } from "../../application/github.ts";
import type { Jira, JiraIssue } from "../../application/jira.ts";
import { noTokenTickets } from "../../application/tickets.ts";
import { GitHubTickets } from "./github-tickets.ts";
import { JiraTickets } from "./jira-tickets.ts";

const issue = (key: string): JiraIssue => ({ key, url: `https://x/browse/${key}`, summary: `s ${key}`, description: "d", status: "To Do", statusCategory: "new", issueType: "Task", priority: null, dueAt: null, labels: [], updated: null, comments: [] });

const fakeJira = () => {
  const jira = {
    search: vi.fn(async () => ({ issues: [issue("A-1"), issue("A-2")], nextPageToken: null })),
    issue: vi.fn(async (key: string) => issue(key)),
    comment: vi.fn(async () => {}),
    transitions: vi.fn(async () => [{ id: "31", name: "Done", to: { name: "Done", categoryKey: "done" } }]),
    transition: vi.fn(async () => {}),
  };
  return { jira, port: new JiraTickets(jira as unknown as Jira) };
};

describe("the Jira side of the tickets port", () => {
  it("lists what a JQL finds as canonical tickets, and reads one", async () => {
    const { jira, port } = fakeJira();
    const list = await port.listInScope({ jql: "assignee = currentUser()" });
    expect(jira.search).toHaveBeenCalledWith("assignee = currentUser()", expect.objectContaining({ maxResults: expect.any(Number) }));
    expect(list.map((t) => t.key)).toEqual(["A-1", "A-2"]);
    expect((await port.read("A-1")).tool).toBe("jira");
  });

  it("comments, links and transitions only when called, by the name of the target status", async () => {
    const { jira, port } = fakeJira();
    expect(jira.comment).not.toHaveBeenCalled();
    await port.comment("A-1", "hello");
    await port.link("A-1", "https://x/pr/1");
    expect(jira.comment).toHaveBeenCalledTimes(2);
    await port.transition("A-1", "Done");
    expect(jira.transition).toHaveBeenCalledWith("A-1", "31");
    await expect(port.transition("A-1", "Nowhere")).rejects.toThrow(/Nowhere/);
  });
});

describe("the GitHub side of the tickets port", () => {
  const gh: GhIssue = { number: 3, title: "t", body: "b", url: "https://github.com/o/r/issues/3", labels: ["ready"], author: "ana" };

  it("lists a repository's labelled issues, and comments on one by its key", async () => {
    const github = { listReadyIssues: vi.fn(async () => [gh]), commentOnIssue: vi.fn(async () => {}) };
    const port = new GitHubTickets(github as unknown as GitHub);
    const list = await port.listInScope({ slug: "o/r", label: "ready" });
    expect(list[0]).toMatchObject({ tool: "github", key: "o/r#3" });
    await port.comment("o/r#3", "hi");
    expect(github.commentOnIssue).toHaveBeenCalledWith("o/r", 3, "hi");
    await expect(port.comment("not a key", "x")).rejects.toThrow();
  });
});

describe("the port with no token", () => {
  it("fails every call with one clear reason", async () => {
    const port = noTokenTickets();
    await expect(port.listInScope({})).rejects.toThrow(/token/i);
    await expect(port.comment("A-1", "x")).rejects.toThrow(/token/i);
  });
});

describe("creating a child ticket (wave 15)", () => {
  const origin = (key: string, tool: "jira" | "github", type: string | null = "Story") => ({ tool, key, type, permalink: "https://x" }) as never;

  it("Jira: in the project of the origin's own key, with the origin's issue type, else Task; the child names no project", async () => {
    const jira = { createIssue: vi.fn(async (project: string, _t: string, _s: string, _d: string) => ({ key: `${project}-9`, url: `https://x/browse/${project}-9` })) };
    const port = new JiraTickets(jira as unknown as Jira);
    expect(await port.create(origin("PAY-12", "jira"), { title: "Part one", body: "Body" })).toEqual({ key: "PAY-9", permalink: "https://x/browse/PAY-9" });
    expect(jira.createIssue).toHaveBeenCalledWith("PAY", "Story", "Part one", "Body");
    await port.create(origin("PAY-12", "jira", null), { title: "t", body: "b" });
    expect(jira.createIssue).toHaveBeenLastCalledWith("PAY", "Task", "t", "b");
    await expect(port.create(origin("not a key", "jira"), { title: "t", body: "b" })).rejects.toThrow();
  });

  it("GitHub: in the origin's own repository, keyed owner/repo#number", async () => {
    const github = { createIssue: vi.fn(async () => ({ number: 41, url: "https://github.com/o/r/issues/41" })) };
    const port = new GitHubTickets(github as unknown as GitHub);
    expect(await port.create(origin("o/r#3", "github"), { title: "Part", body: "B" })).toEqual({ key: "o/r#41", permalink: "https://github.com/o/r/issues/41" });
    expect(github.createIssue).toHaveBeenCalledWith("o/r", { title: "Part", body: "B" });
    await expect(port.create(origin("nope", "github"), { title: "t", body: "b" })).rejects.toThrow();
  });

  it("the port with no token refuses", async () => {
    await expect(noTokenTickets().create(origin("A-1", "jira"), { title: "t", body: "b" })).rejects.toThrow(/token/i);
  });
});
