import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeGitHub } from "../test/github.ts";
import { fakeSlack } from "../test/slack.ts";
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
function wire(options: { slack?: boolean; enabled?: boolean; slackPort?: ReturnType<typeof fakeSlack> | null } = {}) {
  const comments: string[][] = [];
  const posts: Array<Record<string, unknown>> = [];
  let replies: ThreadReplies;
  const pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, onEvent: (event) => void replies.handle(event) });
  replies = new ThreadReplies({
    pipeline,
    enabled: options.enabled ?? true,
    ...(options.slackPort !== undefined ? { slackPort: () => options.slackPort! } : {}),
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
    for (let i = 0; i < 3; i++) await pipeline.decide(task.id, "approved");
    await replies.idle();
    const bodies = comments.map((c) => c.at(-1));
    expect(bodies).toContain("PR opened: https://github.com/o/a/pull/7");
    expect(bodies.at(-1)).toBe("Closed.");
    // A step that needs nobody is not a comment: no "implementing started" noise.
    expect(bodies.filter((b) => /implementing|verifying/.test(b!))).toEqual([]);
  });

  it("says once that a gate is still waiting when the tick records a reminder, and that the task was archived", async () => {
    const { pipeline, replies, comments } = wire();
    const task = await pipeline.createTask({ title: "Export CSV", repoPath: "/r/a", source });
    await pipeline.start(task.id);
    await pipeline.record(task.id, "sla.reminder", { gate: "awaiting_approval", dueAt: "2026-11-05T12:00:00.000Z" });
    await replies.idle();
    expect(comments.at(-1)![2]).toBe("Still waiting on you: approve the plan.");
    await pipeline.archive(task.id, "sla_expired");
    await replies.idle();
    expect(comments.at(-1)![2]).toBe("Archived: sla_expired.");
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

describe("a merged task", () => {
  const shipped = { title: "Export CSV", prUrl: "https://github.com/o/a/pull/7", number: 7, mergedSha: "9c1f0e2a7b3d4e5f", by: "machine", format: "text", howToVerify: "Press Export.", media: [] };
  const summary = "Shipped: Export CSV — https://github.com/o/a/pull/7 (9c1f0e2). How to verify: Press Export. Evidence: text.";

  it("is told to the GitHub issue it came from, once, as one summary", async () => {
    const { pipeline, replies, comments } = wire();
    const task = await pipeline.createTask({ title: "Export CSV", repoPath: "/r/a", source });
    await pipeline.record(task.id, "task.shipped", shipped);
    await replies.idle();
    expect(comments).toEqual([["o/a", "42", summary]]);
  });

  it("is posted into the Slack thread it came from, through the user-token port", async () => {
    const slack = fakeSlack({ postMessage: async () => "2.2" });
    const { pipeline, replies } = wire({ slackPort: slack });
    const task = await pipeline.createTask({ title: "Export CSV", repoPath: "/r/a", source: { kind: "slack", channel: "C9", ts: "1.5", permalink: "https://x/p" } });
    await pipeline.record(task.id, "task.shipped", shipped);
    await replies.idle();
    expect(slack.calls).toEqual([["postMessage", "C9", summary, "1.5"]]);
  });

  it("posts nothing to Slack for a task from elsewhere, nor without a token", async () => {
    const slack = fakeSlack({ postMessage: async () => "2.2" });
    const a = wire({ slackPort: slack });
    const task = await a.pipeline.createTask({ title: "t", repoPath: "/r/a", source });
    await a.pipeline.record(task.id, "task.shipped", shipped);
    await a.replies.idle();
    expect(slack.calls).toEqual([]);
    const b = wire({ slackPort: null });
    const slackTask = await b.pipeline.createTask({ title: "t", repoPath: "/r/a", source: { kind: "slack", channel: "C9", ts: "1.5", permalink: "https://x/p" } });
    await b.pipeline.record(slackTask.id, "task.shipped", shipped);
    await b.replies.idle();
    expect(slack.calls).toEqual([]);
  });
});

describe("an escalation's reason reaches a channel flattened", () => {
  it("posts it on one line with no mention, no issue link, no HTML and no token", async () => {
    const token = "gh" + "p_" + "e".repeat(24);
    const { pipeline, replies, comments } = wire();
    const task = await pipeline.createTask({ title: "t", repoPath: "/r/a", source });
    await pipeline.record(task.id, "transition", { from: "shipping", to: "escalated", event: "stage_done", reason: `<!channel> @team see #12\n${token}` });
    await replies.idle();
    const body = comments.at(-1)![2]!;
    expect(body).toMatch(/^Escalated: /);
    expect(body).not.toMatch(/<!channel>|@team|#12|\n.|ghp_/);
    expect(body).toContain("[redacted]");
  });
});

describe("ThreadReplies: a reply and triage's questions go to the card's own source only", () => {
  const slackSource = { kind: "slack" as const, channel: "C0SRC", ts: "1700.01", permalink: "https://x.slack.com/archives/C0SRC/p1" };
  const event = (taskId: string, kind: string, body: string) => ({ id: "e", taskId, kind, payload: { body }, at: new Date(), stageRunId: null }) as never;

  it("posts a conversation's reply on the GitHub issue, flattened, and not in the machine's own Slack thread", async () => {
    const { pipeline, replies, comments, posts } = wire({ slack: true });
    const task = await pipeline.createTask({ title: "Q", repoPath: "/r/a", source });
    await replies.handle(event(task.id, "task.reply", "Use\n`pnpm dev` <b>and</b> ask @bob about #12"));
    expect(comments).toHaveLength(1);
    expect(comments[0]![2]).not.toMatch(/\n|<b>|@bob|#12/);
    expect(comments[0]![2]).toContain("pnpm dev");
    expect(posts).toEqual([]);
  });

  it("posts the questions into the Slack thread the card came from, through your user token", async () => {
    const slackPort = fakeSlack();
    const { pipeline, replies, comments } = wire({ slackPort });
    const task = await pipeline.createTask({ title: "Q", repoPath: "/r/a", source: slackSource as never });
    await replies.handle(event(task.id, "task.questions", "Luna needs your answers to go on: 1) Is this a bug?"));
    expect(slackPort.postMessage).toHaveBeenCalledWith("C0SRC", expect.stringContaining("Is this a bug?"), "1700.01");
    expect(comments).toEqual([]);
  });

  it("posts nothing for a card with no source, for a notch card, or for text carrying a token", async () => {
    const slackPort = fakeSlack();
    const { pipeline, replies, comments } = wire({ slackPort });
    const manual = await pipeline.createTask({ title: "M", repoPath: "/r/a" });
    await replies.handle(event(manual.id, "task.reply", "an answer"));
    const gh = await pipeline.createTask({ title: "G", repoPath: "/r/a", source });
    await replies.handle(event(gh.id, "task.reply", `here is a key ${["ghp", "a".repeat(36)].join("_")}`));
    expect(comments).toEqual([]);
    expect(slackPort.postMessage).not.toHaveBeenCalled();
  });

  it("never posts to a thread the card did not come from: a GitHub card's questions stay off Slack", async () => {
    const slackPort = fakeSlack();
    const { pipeline, replies, comments } = wire({ slackPort });
    const gh = await pipeline.createTask({ title: "G", repoPath: "/r/a", source });
    await replies.handle(event(gh.id, "task.questions", "Luna needs your answers to go on: 1) Which one?"));
    expect(comments).toHaveLength(1);
    expect(slackPort.postMessage).not.toHaveBeenCalled();
  });
});

describe("ThreadReplies: a question flagged secret is refused", () => {
  it("posts nothing for questions whose raw text carried a token, and posts the flattened ones", async () => {
    const { pipeline, replies, comments } = wire();
    const task = await pipeline.createTask({ title: "Q", repoPath: "/r/a", source });
    const event = (payload: Record<string, unknown>) => ({ id: "e", taskId: task.id, kind: "task.questions", payload, at: new Date(), stageRunId: null }) as never;
    await replies.handle(event({ body: "Luna needs your answers to go on: 1) Is [redacted] yours?", secret: true, hash: "a" }));
    expect(comments).toEqual([]);
    await replies.handle(event({ body: "Luna needs your answers to go on: 1) Which one?", secret: false, hash: "b" }));
    expect(comments).toHaveLength(1);
  });
});
