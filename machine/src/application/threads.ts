// Replies in the thread a task came from, the way every platform studied notifies: a comment
// on the originating GitHub issue, and a Slack thread per task when a token and channel are
// set; never for a notch task, whose ticket the notch talks about. Only the moments that
// matter get a line: picked up, needs you, escalated, paused, the PR, closed. Stage-to-stage
// progress stays on the board.
import { RUN_OR_GATE, WAITING_ON_USER, type TaskState } from "@hardness/contracts";
import { basename } from "node:path";

import { safe } from "../domain/evidence-markdown.ts";
import { archivedNotice } from "../domain/notices.ts";
import { carriesSecret, postable } from "../domain/postable.ts";
import { fromNotch } from "../domain/jira-link.ts";
import { type GitHub, messageOf } from "./github.ts";
import type { EventRow, TaskRow } from "../domain/task.ts";
import type { Pipeline } from "./pipeline.ts";
import { ShippedEvent, shippedSummary } from "./ship-loop.ts";
import type { Slack } from "./slack.ts";

export interface SlackOptions {
  token: string;
  channel: string;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
}

export interface ThreadRepliesOptions {
  pipeline: Pick<Pipeline, "get" | "events" | "record">;
  /** `MACHINE_THREAD_REPLIES=off` turns every reply off. */
  enabled: boolean;
  /** Posts the issue comments. */
  github: GitHub;
  slack?: SlackOptions;
  /** Your Slack user token's port, read when a task ships (it is built after this class): the summary goes into the thread the task came from. Null or absent: nowhere to post. */
  slackPort?: () => Pick<Slack, "postMessage"> | null;
}

/** What a gate asks of you, as the reply says it. */
const ASKS: Partial<Record<TaskState, string>> = {
  awaiting_answers: "answer triage's questions",
  awaiting_approval: "approve the plan",
  awaiting_test_check: "check the tests",
  awaiting_ship: "choose how to ship",
  reviewing_memory: "review the memory proposal",
};

const SLACK_API = "https://slack.com/api/chat.postMessage";

/** A transition into a state that waits on a person; a state that holds a stage or a gate waits only when the step opened a gate (also when it stays in the state). */
export const needsYou = (to: TaskState, from: TaskState, gate: boolean): boolean => (RUN_OR_GATE.has(to) ? gate : WAITING_ON_USER.has(to) && to !== from);

export class ThreadReplies {
  private readonly pending = new Set<Promise<void>>();
  /** Slack thread per task, once known; filled from `thread.opened` events after a restart. */
  private readonly threads = new Map<string, string>();
  /** PR urls already announced per task. */
  private readonly announced = new Map<string, Set<string>>();

  constructor(private readonly options: ThreadRepliesOptions) {}

  /** Reacts to one pipeline event. Never throws; failures are logged. Returns once sent. */
  handle(event: EventRow): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    const run = this.react(event).catch((error: unknown) => console.warn(`thread reply for task ${event.taskId} failed`, error));
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
    return run;
  }

  /** Resolves once every reply in flight has been sent (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async react(event: EventRow): Promise<void> {
    if (event.kind === "transition") {
      const to = event.payload.to as TaskState;
      const from = event.payload.from as TaskState;
      if (from === "draft" && event.payload.event === "start") return this.open(event.taskId);
      if (to === "escalated") return this.reply(event.taskId, `Escalated: ${safe(String(event.payload.reason ?? "see the board"))}.`);
      if (to === "paused_rate_limit") return this.reply(event.taskId, "Paused on a usage limit; it resumes by itself.");
      if (to === "closed") return this.reply(event.taskId, "Closed.");
      if (to === "archived") return this.reply(event.taskId, archivedNotice(event.payload.archiveReason));
      if (needsYou(to, from, event.payload.gate === true)) return this.reply(event.taskId, `Needs you: ${ASKS[to] ?? to}.`);
      return;
    }
    // A conversation outcome's answer (approved in one tap) and triage's questions: posted where the card came from, and nowhere else.
    if (event.kind === "task.reply" || event.kind === "task.questions") return typeof event.payload.body === "string" && event.payload.body ? this.toSource(event.taskId, event.payload.body, event.payload.secret === true) : undefined;
    if (event.kind === "sla.reminder") {
      const gate = event.payload.gate as TaskState;
      return this.reply(event.taskId, `Still waiting on you: ${ASKS[gate] ?? gate}.`);
    }
    // The names stay on the event and the board: nothing outward says who the owners are, or how many.
    if (event.kind === "sla.escalated") return this.reply(event.taskId, "The plan has waited too long for approval and was escalated to the code owners.");
    if (event.kind === "task.shipped") return this.shipped(event);
    if (event.kind === "stage.finished") {
      const detail = event.payload.detail as { prUrl?: unknown } | undefined;
      const url = typeof detail?.prUrl === "string" ? detail.prUrl : null;
      if (!url) return;
      const seen = this.announced.get(event.taskId) ?? new Set<string>();
      if (seen.has(url)) return;
      seen.add(url);
      this.announced.set(event.taskId, seen);
      return this.reply(event.taskId, `PR opened: ${url}`);
    }
  }

  /** Text a model or a person wrote, flattened with `postable`, to the card's own source only: its GitHub issue, or the Slack thread it came
   *  from through your user token. A card with no source gets nothing; a Jira ticket is JiraSync's. Text that carries a token is not posted. */
  private async toSource(taskId: string, text: string, secret = false): Promise<void> {
    const task = await this.options.pipeline.get(taskId);
    if (fromNotch(task)) return;
    const body = postable(text);
    if (!body) return;
    // Flattening redacts a token, but a text that carried one is a drafted answer nobody should post as it stands.
    if (secret || carriesSecret(text)) {
      console.warn(`not posting to the source of task ${taskId}: the text carried a secret-shaped token`);
      return;
    }
    const source = task.source;
    if (source?.kind === "github") return this.comment(task, body);
    if (source?.kind !== "slack") return;
    const port = this.options.slackPort?.();
    if (!port) return;
    try {
      await port.postMessage(source.channel, body, source.ts);
    } catch (error) {
      console.warn(`slack post to the source thread failed for task ${taskId}: ${messageOf(error)}`);
    }
  }

  /** The PR merged: the summary on the issue and the machine's thread as any reply, and in the Slack thread the task came from. */
  private async shipped(event: EventRow): Promise<void> {
    const parsed = ShippedEvent.safeParse(event.payload);
    if (!parsed.success) return;
    const text = shippedSummary(parsed.data);
    await this.reply(event.taskId, text);
    const task = await this.options.pipeline.get(event.taskId);
    const source = task.source;
    const port = this.options.slackPort?.();
    if (source?.kind !== "slack" || !port) return;
    try {
      await port.postMessage(source.channel, text, source.ts);
    } catch (error) {
      console.warn(`slack post of the shipped summary failed for task ${event.taskId}: ${messageOf(error)}`);
    }
  }

  /** The task was picked up: a first comment on its issue, and the root of its Slack thread. */
  private async open(taskId: string): Promise<void> {
    const task = await this.options.pipeline.get(taskId);
    if (fromNotch(task)) return;
    const short = task.id.slice(0, 8);
    await this.comment(task, `Picked up by the pipeline as task #${short}: triage is planning it.`);
    if (!this.options.slack) return;
    const repo = task.repoPath ? ` · ${basename(task.repoPath)}` : "";
    const ts = await this.post({ channel: this.options.slack.channel, text: `#${short} ${task.title}${repo}: triage is planning it.` });
    if (!ts) return;
    this.threads.set(taskId, ts);
    await this.options.pipeline.record(taskId, "thread.opened", { kind: "slack", channel: this.options.slack.channel, ts });
  }

  private async reply(taskId: string, text: string): Promise<void> {
    const task = await this.options.pipeline.get(taskId);
    if (fromNotch(task)) return;
    await this.comment(task, text);
    const slack = this.options.slack;
    if (!slack) return;
    const ts = await this.threadOf(taskId);
    if (!ts) return;
    await this.post({ channel: slack.channel, thread_ts: ts, text });
  }

  /** A comment on the originating GitHub issue, when the task came from one. */
  private async comment(task: TaskRow, body: string): Promise<void> {
    const source = task.source;
    if (!source || source.kind !== "github") return;
    try {
      await this.options.github.commentOnIssue(source.repo, source.number, body);
    } catch (error) {
      console.warn(`issue comment failed for ${source.repo}#${source.number}: ${messageOf(error)}`);
    }
  }

  /** The task's Slack thread, from memory or from the `thread.opened` event a previous machine logged. */
  private async threadOf(taskId: string): Promise<string | null> {
    const known = this.threads.get(taskId);
    if (known) return known;
    const opened = (await this.options.pipeline.events(taskId)).find((e) => e.kind === "thread.opened" && e.payload.kind === "slack");
    const ts = typeof opened?.payload.ts === "string" ? opened.payload.ts : null;
    if (ts) this.threads.set(taskId, ts);
    return ts;
  }

  /** One `chat.postMessage`; the message's ts on success, null (logged) otherwise. */
  private async post(body: { channel: string; text: string; thread_ts?: string }): Promise<string | null> {
    const slack = this.options.slack!;
    const response = await (slack.fetch ?? fetch)(SLACK_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${slack.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as { ok?: boolean; ts?: string; error?: string };
    if (!answer.ok || typeof answer.ts !== "string") {
      console.warn(`slack chat.postMessage failed: ${answer.error ?? "no ts in the answer"}`);
      return null;
    }
    return answer.ts;
  }
}
