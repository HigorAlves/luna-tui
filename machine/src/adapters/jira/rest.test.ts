import { describe, expect, it } from "vitest";

import { JiraAuthError, JiraError, JiraNotFoundError } from "../../application/jira.ts";
import { createJira } from "./rest.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = { status?: number; headers?: Record<string, string>; json?: unknown; text?: string; throws?: Error };

/** A fetch that answers from a queue (or a function of the call) and records every call. */
function wire(answer: Answer | Answer[] | ((call: Call) => Answer), over: { cloudId?: string } = {}) {
  const calls: Call[] = [];
  const queue = Array.isArray(answer) ? [...answer] : null;
  const fetchFake = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const a: Answer = queue ? (queue.shift() ?? { status: 500, text: "queue empty" }) : typeof answer === "function" ? answer(call) : (answer as Answer);
    if (a.throws) throw a.throws;
    const status = a.status ?? 200;
    const text = a.text ?? (a.json === undefined ? "" : JSON.stringify(a.json));
    return { status, ok: status >= 200 && status < 300, headers: new Headers(a.headers ?? {}), text: async () => text };
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const jira = createJira({ site: "https://acme.atlassian.net/", email: "me@acme.com", token: "tok", fetch: fetchFake, sleep: async (ms) => void slept.push(ms), ...over });
  return { jira, calls, slept };
}

const text = (value: string) => ({ type: "text", text: value });
const issueJson = {
  key: "PLAT-123",
  fields: {
    summary: "Login page",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [text("Users sign in.")] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("bad password errors")] }] }] }] },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Story" },
    priority: { name: "High" },
    duedate: "2026-10-31",
    labels: ["luna"],
    updated: "2026-10-28T10:00:00.000+0000",
    comment: { comments: [{ author: { accountId: "A1", displayName: "Marta" }, body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [text("please")] }] }, created: "2026-10-27T09:00:00.000+0000" }] },
  },
};

describe("createJira", () => {
  it("reads an issue with basic auth and the fields the machine needs, description and comments as markdown", async () => {
    const { jira, calls } = wire({ json: issueJson });
    const issue = await jira.issue("PLAT-123");
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/PLAT-123?fields=summary%2Cdescription%2Cstatus%2Cissuetype%2Cpriority%2Cduedate%2Clabels%2Cupdated%2Ccomment");
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`);
    expect(issue).toEqual({
      key: "PLAT-123",
      url: "https://acme.atlassian.net/browse/PLAT-123",
      summary: "Login page",
      description: "Users sign in.\n\n- bad password errors",
      status: "In Progress",
      statusCategory: "indeterminate",
      issueType: "Story",
      priority: "High",
      dueAt: "2026-10-31",
      labels: ["luna"],
      updated: "2026-10-28T10:00:00.000+0000",
      comments: [{ author: "Marta", authorId: "A1", text: "please", created: "2026-10-27T09:00:00.000+0000" }],
    });
  });

  it("lists transitions with their target status and performs one with the transition body Jira expects", async () => {
    const { jira, calls } = wire([
      { json: { transitions: [{ id: "31", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }, { id: "41", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } }] } },
      { status: 204 },
    ]);
    expect(await jira.transitions("PLAT-123")).toEqual([
      { id: "31", name: "Start", to: { name: "In Progress", categoryKey: "indeterminate" } },
      { id: "41", name: "Finish", to: { name: "Done", categoryKey: "done" } },
    ]);
    await jira.transition("PLAT-123", "41", { customfield_10045: "https://github.com/o/a/pull/7" });
    expect(calls[1]).toMatchObject({ method: "POST", url: "https://acme.atlassian.net/rest/api/3/issue/PLAT-123/transitions", body: { transition: { id: "41" }, fields: { customfield_10045: "https://github.com/o/a/pull/7" } } });
    expect(calls[1]!.headers["Content-Type"]).toBe("application/json");
  });

  it("posts a comment as an ADF document built from the text, and edits fields with PUT", async () => {
    const { jira, calls } = wire([{ status: 201, json: { id: "1" } }, { status: 204 }]);
    await jira.comment("PLAT-123", "PR opened: https://github.com/o/a/pull/7\n\n- one\n- two");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://acme.atlassian.net/rest/api/3/issue/PLAT-123/comment" });
    expect(calls[0]!.body).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [text("PR opened: "), { type: "text", text: "https://github.com/o/a/pull/7", marks: [{ type: "link", attrs: { href: "https://github.com/o/a/pull/7" } }] }] },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("one")] }] }, { type: "listItem", content: [{ type: "paragraph", content: [text("two")] }] }] },
        ],
      },
    });
    await jira.editFields("PLAT-123", { customfield_1: "x" });
    expect(calls[1]).toMatchObject({ method: "PUT", url: "https://acme.atlassian.net/rest/api/3/issue/PLAT-123", body: { fields: { customfield_1: "x" } } });
  });

  it("searches with POST /search/jql, paging by nextPageToken, and creates an issue from markdown", async () => {
    const { jira, calls } = wire([{ json: { issues: [issueJson], nextPageToken: "abc", isLast: false } }, { json: { issues: [], isLast: true } }, { status: 201, json: { id: "9", key: "PLAT-200", self: "x" } }]);
    const first = await jira.search('project = PLAT AND labels = luna ORDER BY updated DESC', { maxResults: 15 });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://acme.atlassian.net/rest/api/3/search/jql", body: { jql: 'project = PLAT AND labels = luna ORDER BY updated DESC', maxResults: 15 } });
    expect((calls[0]!.body as { fields: string[] }).fields).toContain("summary");
    expect(first.issues.map((i) => i.key)).toEqual(["PLAT-123"]);
    expect(first.nextPageToken).toBe("abc");
    const second = await jira.search("project = PLAT", { nextPageToken: "abc" });
    expect(calls[1]!.body).toMatchObject({ nextPageToken: "abc", maxResults: 50 });
    expect(second).toEqual({ issues: [], nextPageToken: null });
    expect(await jira.createIssue("PLAT", "Story", "Login page", "Why.\n\n- [ ] errors show")).toEqual({ key: "PLAT-200", url: "https://acme.atlassian.net/browse/PLAT-200" });
    expect(calls[2]!.body).toMatchObject({ fields: { project: { key: "PLAT" }, issuetype: { name: "Story" }, summary: "Login page", description: { type: "doc", version: 1 } } });
  });

  it("answers who the token is and the project's status names, each once", async () => {
    const { jira } = wire([
      { json: { accountId: "A1", displayName: "Higor", emailAddress: "me@acme.com" } },
      { json: [{ name: "Story", statuses: [{ name: "To Do", statusCategory: { key: "new" } }, { name: "Done", statusCategory: { key: "done" } }] }, { name: "Bug", statuses: [{ name: "To Do", statusCategory: { key: "new" } }, { name: "Blocked", statusCategory: { key: "indeterminate" } }] }] },
    ]);
    expect(await jira.me()).toEqual({ accountId: "A1", displayName: "Higor", email: "me@acme.com", timeZone: null });
    expect(await jira.statuses("PLAT")).toEqual([{ name: "To Do", categoryKey: "new" }, { name: "Done", categoryKey: "done" }, { name: "Blocked", categoryKey: "indeterminate" }]);
  });

  it("honours Retry-After once on a 429, then gives up with a rate-limit message", async () => {
    const ok = { json: { accountId: "A1", displayName: "H" } };
    const limited = { status: 429, headers: { "Retry-After": "3" }, text: "slow down" };
    const once = wire([limited, ok]);
    await once.jira.me();
    expect(once.slept).toEqual([3000]);
    expect(once.calls).toHaveLength(2);
    const twice = wire([limited, limited]);
    await expect(twice.jira.me()).rejects.toThrow(/rate limit on GET myself: retry after 3s/);
  });

  it("retries a 5xx or a dropped connection twice with a growing pause, then reports the last failure", async () => {
    const ok = { json: { accountId: "A1", displayName: "H" } };
    const recovered = wire([{ status: 502, text: "bad gateway" }, { throws: new Error("fetch failed: ECONNRESET") }, ok]);
    await recovered.jira.me();
    expect(recovered.calls).toHaveLength(3);
    expect(recovered.slept).toEqual([1000, 3000]);
    const down = wire([{ status: 503, text: "down" }, { status: 503, text: "down" }, { status: 503, json: { errorMessages: ["still down"] } }]);
    const error = (await down.jira.me().catch((e: unknown) => e)) as JiraError;
    expect(error).toBeInstanceOf(JiraError);
    expect(error.message).toBe("GET myself: still down");
    expect(error.status).toBe(503);
    expect(down.calls).toHaveLength(3);
    const dropped = wire([{ throws: new Error("fetch failed") }, { throws: new Error("fetch failed") }, { throws: new Error("fetch failed") }]);
    await expect(dropped.jira.me()).rejects.toThrow("GET myself: fetch failed");
    expect(dropped.calls).toHaveLength(3);
    // A 4xx is Jira's answer, not a hiccup: no retry.
    const refused = wire([{ status: 400, text: "no" }, ok]);
    await expect(refused.jira.me()).rejects.toBeInstanceOf(JiraError);
    expect(refused.calls).toHaveLength(1);
  });

  it("turns a 401 into a clear token error (with the expiry when the answer names one), a 404 issue into JiraNotFoundError, and other failures into Jira's words", async () => {
    const expired = wire({ status: 401, json: { errorMessages: ["Token expired at 2026-11-01T00:00:00Z"] } });
    const error = await expired.jira.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraAuthError);
    expect((error as JiraAuthError).message).toMatch(/rejected the token.*expired or revoked.*Token expired/);
    expect((error as JiraAuthError).expiresAt).toBe("2026-11-01T00:00:00Z");
    const plain = wire({ status: 401, text: "Unauthorized" });
    expect(((await plain.jira.me().catch((e: unknown) => e)) as JiraAuthError).expiresAt).toBeNull();
    const missing = wire({ status: 404, json: { errorMessages: ["Issue does not exist or you do not have permission to see it."] } });
    await expect(missing.jira.issue("PLAT-9")).rejects.toBeInstanceOf(JiraNotFoundError);
    const refused = wire({ status: 400, json: { errorMessages: [], errors: { resolution: "Field 'resolution' is required" } } });
    const e = await refused.jira.transition("PLAT-1", "41").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(JiraError);
    expect((e as JiraError).message).toBe("POST issue/PLAT-1/transitions: resolution: Field 'resolution' is required");
    expect((e as JiraError).status).toBe(400);
  });

  it("goes through api.atlassian.com for a scoped token while issue urls still point at the site", async () => {
    const { jira, calls } = wire({ json: issueJson }, { cloudId: "11111111-2222" });
    const issue = await jira.issue("PLAT-123");
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.atlassian\.com\/ex\/jira\/11111111-2222\/rest\/api\/3\/issue\/PLAT-123\?/);
    expect(issue.url).toBe("https://acme.atlassian.net/browse/PLAT-123");
  });
});
