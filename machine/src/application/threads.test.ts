import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeGitHub } from "../test/github.ts";
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

const source = { kind: "github" as const, repo: "o/a", number: 42, url: "https://github.com/o/a/issues/42" };

/** A pipeline whose events feed the replies, and what the replies sent out. */
function wire(options: { slack?: boolean; enabled?: boolean } = {}) {
  const comments: string[][] = [];
  const posts: Array<Record<string, unknown>> = [];
  let replies: ThreadReplies;
  const pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, onEvent: (event) => void replies.handle(event) });
  replies = new ThreadReplies({
    pipeline,
    enabled: options.enabled ?? true,
    github: fakeGitHub({
      commentOnIssue: async (repo, number, body) => {
        comments.push([repo, String(number), body]);
      },
    }),
    slack: options.slack
      ? {
          token: "xoxb-test",
          channel: "C123",
          fetch: (async (_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body) as Record<string, unknown>;
            posts.push(body);
            return { json: async () => ({ ok: true, ts: body.thread_ts ? "9.9" : "1.1" }) };
          }) as unknown as typeof fetch,
        }
      : undefined,
  });
  return { pipeline, replies, comments, posts };
}

describe("ThreadReplies", () => {
  it("comments on the originating GitHub issue when the task starts, needs you, gets its PR, and closes", async () => {
    const { pipeline, replies, comments } = wire();
    const task = await pipeline.createTask({ title: "Export CSV", repoPath: "/r/a", source });
    await pipeline.start(task.id);
    await replies.idle();
    expect(comments).toEqual([
      ["o/a", "42", `Picked up by the pipeline as task #${task.id.slice(0, 8)}: triage is planning it.`],
      ["o/a", "42", "Needs you: approve the plan."],
    ]);

    stubs.plan("delivering", { outcome: "pass", detail: { prUrl: "https://github.com/o/a/pull/7", prNumber: 7 } });
    for (let i = 0; i < 4; i++) await pipeline.decide(task.id, "approved");
    await replies.idle();
    const bodies = comments.map((c) => c.at(-1));
    expect(bodies).toContain("PR opened: https://github.com/o/a/pull/7");
    expect(bodies.at(-1)).toBe("Closed.");
    // A step that needs nobody is not a comment: no "implementing started" noise.
    expect(bodies.filter((b) => /implementing|verifying/.test(b!))).toEqual([]);
  });

  it("says why when the task escalates, and that it paused on a usage limit", async () => {
    const { pipeline, replies, comments } = wire();
    stubs.plan("triage", { outcome: "fail" }, { outcome: "fail" }, { outcome: "fail" });
    const task = await pipeline.createTask({ title: "t", source });
    await pipeline.start(task.id);
    await replies.idle();
    expect(comments.at(-1)?.at(-1)).toMatch(/^Escalated: /);
  });

  it("opens a Slack thread per task and replies in it, remembering the thread across a restart", async () => {
    const { pipeline, replies, posts } = wire({ slack: true });
    const task = await pipeline.createTask({ title: "Export CSV", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await replies.idle();
    expect(posts[0]).toEqual({ channel: "C123", text: `#${task.id.slice(0, 8)} Export CSV · a: triage is planning it.` });
    expect(posts[1]).toEqual({ channel: "C123", thread_ts: "1.1", text: "Needs you: approve the plan." });
    expect((await pipeline.events(task.id)).find((e) => e.kind === "thread.opened")?.payload).toEqual({ kind: "slack", channel: "C123", ts: "1.1" });

    // A new machine over the same database finds the thread in the task's events.
    const again = wire({ slack: true });
    const fresh = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, onEvent: (event) => void again.replies.handle(event) });
    await fresh.decide(task.id, "sent_back", "redo");
    await again.replies.idle();
    expect(again.posts).toEqual([{ channel: "C123", thread_ts: "1.1", text: "Needs you: approve the plan." }]);
  });

  it("stays quiet when turned off, and for a task with no thread to reply in", async () => {
    const off = wire({ enabled: false });
    const task = await off.pipeline.createTask({ title: "t", source });
    await off.pipeline.start(task.id);
    await off.replies.idle();
    expect(off.comments).toEqual([]);

    const { pipeline, replies, comments, posts } = wire();
    const local = await pipeline.createTask({ title: "t" });
    await pipeline.start(local.id);
    await replies.idle();
    expect(comments).toEqual([]);
    expect(posts).toEqual([]);
  });
});
