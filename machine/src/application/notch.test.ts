// A task the notch made never reaches Jira, Slack or Teams from the machine: the notch owns the
// ticket and talks about it; the machine only runs it.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY } from "../domain/policy.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeGitHub } from "../test/github.ts";
import { WORKFLOW, fakeJira } from "../test/jira.ts";
import { JiraSync } from "./jira-sync.ts";
import { JiraTasks, NotchTaskError } from "./jira-tasks.ts";
import { JiraWatch } from "./jira-watch.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { ThreadReplies } from "./threads.ts";

let db: DataSource;
const stubs = new StubStages();

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
});

const SITE = "https://acme.atlassian.net";
const notch = { kind: "notch" as const, ref: "LUNA-14", id: "8f1c0d7e-0000-0000-0000-000000000000", jiraKey: "PLAT-123" };

/** A pipeline whose events feed JiraSync and the Slack thread replies, over a fake Jira that has the issue. */
function wire() {
  const jira = fakeJira({ issues: [{ key: "PLAT-123", status: "To Do", statusCategory: "new", issueType: "Bug" }], transitions: WORKFLOW });
  const reads = [vi.spyOn(jira, "issue"), vi.spyOn(jira, "transitions"), vi.spyOn(jira, "me")];
  const posts: unknown[] = [];
  let sync: JiraSync;
  let replies: ThreadReplies;
  const pipeline = new Pipeline(db, stubs.runnerFor, {
    inline: true,
    hasConfig: () => true,
    jiraSite: SITE,
    policies: {
      for: async () => ({
        ...DEFAULT_POLICY,
        jira: { project: "PLAT", intake: null, on: { implementing: "In Progress", closed: "Done" }, comments: "gates", fields: {}, branch: "{type}/{key}" },
      }),
    },
    onEvent: (event) => {
      void sync.handle(event);
      void replies.handle(event);
    },
  });
  sync = new JiraSync({ pipeline, jira, enabled: true });
  replies = new ThreadReplies({
    pipeline,
    enabled: true,
    github: fakeGitHub(),
    slack: {
      token: "xoxb-test",
      channel: "C123",
      fetch: (async (_url: string, init: { body: string }) => {
        posts.push(JSON.parse(init.body));
        return { json: async () => ({ ok: true, ts: "1.1" }) };
      }) as unknown as typeof fetch,
    },
  });
  const calls = () => reads.reduce((n, spy) => n + spy.mock.calls.length, 0) + jira.writes.length;
  return { pipeline, jira, sync, replies, posts, calls };
}

describe("a notch task", () => {
  it("walks the whole pipeline with no Jira call and no Slack post, even with a Jira key in its text", async () => {
    const { pipeline, jira, sync, replies, posts, calls } = wire();
    const task = await pipeline.createTask({ title: "PLAT-123 Login page", repoPath: "/r/a", source: notch });
    expect(task.jira).toBeNull();

    stubs.plan("delivering", { outcome: "pass", detail: { prUrl: "https://github.com/o/a/pull/7", prNumber: 7 } });
    await pipeline.start(task.id);
    for (let i = 0; i < 4; i++) await pipeline.decide(task.id, "approved");
    expect((await pipeline.get(task.id)).state).toBe("closed");
    await Promise.all([sync.idle(), replies.idle()]);

    expect(calls()).toBe(0);
    expect(jira.comments).toEqual({});
    expect(posts).toEqual([]);
    expect((await pipeline.events(task.id)).filter((e) => e.kind.startsWith("jira.") || e.kind === "thread.opened")).toEqual([]);
  });

  it("is left alone by JiraWatch and by a retry of a blocked transition", async () => {
    const { pipeline, jira, sync, calls } = wire();
    const task = await pipeline.createTask({ title: "PLAT-123 Login page", source: notch });
    const watch = new JiraWatch({ pipeline, jira, intervalMs: 300_000, retryBlocked: (t) => sync.retry(t), warn: () => {} });
    await watch.pollOnce();
    await sync.retry(task);
    expect(calls()).toBe(0);
  });

  it("cannot be linked to an issue or create one by hand", async () => {
    const { pipeline, jira, calls } = wire();
    const task = await pipeline.createTask({ title: "Login page", source: notch });
    const tasks = new JiraTasks({ jira, site: SITE, pipeline });
    await expect(tasks.link(task.id, "PLAT-123")).rejects.toBeInstanceOf(NotchTaskError);
    await expect(tasks.create(task.id, {})).rejects.toBeInstanceOf(NotchTaskError);
    expect(calls()).toBe(0);
    expect((await pipeline.get(task.id)).jira).toBeNull();
  });

  it("holds its Jira key, so intake does not import the issue the notch runs", async () => {
    const { pipeline } = wire();
    const task = await pipeline.createTask({ title: "Login page", source: notch });
    expect((await pipeline.findByJiraKey("PLAT-123"))?.id).toBe(task.id);
    expect(await pipeline.findByJiraKey("PLAT-9")).toBeNull();
  });
});
