// Replies in the thread a task came from, the way every platform studied notifies: a comment
// on the originating GitHub issue, and a Slack thread per task when a token and channel are
// set; never for a notch task, whose ticket the notch talks about. Only the moments that
// matter get a line: picked up, needs you, escalated, paused, the PR, closed. Stage-to-stage
// progress stays on the board.
import { WAITING_ON_USER, type TaskState } from "@hardness/contracts";
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
import { type Authority, SlackSender, standingOf, tapOfEvent } from "./slack-send.ts";
import type { ConversationDrafts, DraftKind } from "./conversation-drafts.ts";
import type { SlackStore } from "./slack-store.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import { cardOf } from "../domain/card-fields.ts";

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
  slackPort?: () => Slack | null;
  /** The one door to Slack (tests share one to read what was written); built from the port when absent. */
  sender?: SlackSender;
  /** Where a card's outbound updates wait for a tap: drafts on the thread the card came from. */
  drafts?: ConversationDrafts;
  /** The conversation a card came from (`itemByTask`) and the threads attached to it (`item`). */
  store?: Pick<SlackStore, "itemByTask" | "item" | "save">;
  /** Whether the card's repository set `conversation.auto: on`: only then does the machine post by itself. Absent: off, failing closed. */
  autoOf?: (task: TaskRow) => boolean | Promise<boolean>;
}

/** What a gate asks of you, as the reply says it. */
const ASKS: Partial<Record<TaskState, string>> = {
  awaiting_answers: "answer triage's questions",
  awaiting_approval: "approve the plan",
  awaiting_test_check: "check the tests",
  awaiting_ship: "choose how to ship",
  reviewing_memory: "review the memory proposal",
};

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
    const moment = this.momentOf(event);
    if (event.kind === "transition" || event.kind === "sla.reminder" || event.kind === "sla.escalated" || event.kind === "task.shipped" || event.kind === "stage.finished") {
      if (event.kind === "task.shipped") return this.shipped(event);
      if (event.kind === "stage.finished" && !moment) return;
      if (!moment) return;
      return this.reply(event.taskId, moment.text, moment.status);
    }
    // A conversation outcome's answer (approved in one tap) and triage's questions: where the card came from, and nowhere else.
    if (event.kind === "task.reply" || event.kind === "task.questions") return typeof event.payload.body === "string" && event.payload.body ? this.toSource(event, event.payload.body, event.payload.secret === true) : undefined;
  }

  /** The moments that matter, as one line of fixed words; `status` marks the ones that become a draft on the originating thread when the repository has not turned `conversation.auto` on. */
  private momentOf(event: EventRow): { text: string; status: boolean } | null {
    if (event.kind === "transition") {
      const to = event.payload.to as TaskState;
      const from = event.payload.from as TaskState;
      if (from === "draft" && event.payload.event === "start") return { text: "__open__", status: true };
      if (to === "escalated") return { text: `Escalated: ${safe(String(event.payload.reason ?? "see the board"))}.`, status: true };
      if (to === "paused_rate_limit") return { text: "Paused on a usage limit; it resumes by itself.", status: false };
      if (to === "closed") return { text: "Closed.", status: true };
      if (to === "archived") return { text: archivedNotice(event.payload.archiveReason), status: true };
      if (WAITING_ON_USER.has(to) && to !== from) return { text: `Needs you: ${ASKS[to] ?? to}.`, status: false };
      return null;
    }
    if (event.kind === "sla.reminder") {
      const gate = event.payload.gate as TaskState;
      return { text: `Still waiting on you: ${ASKS[gate] ?? gate}.`, status: false };
    }
    // The names stay on the event and the board: nothing outward says who the owners are, or how many.
    if (event.kind === "sla.escalated") return { text: "The plan has waited too long for approval and was escalated to the code owners.", status: false };
    if (event.kind === "stage.finished") {
      const detail = event.payload.detail as { prUrl?: unknown } | undefined;
      const url = typeof detail?.prUrl === "string" ? detail.prUrl : null;
      if (!url) return null;
      const seen = this.announced.get(event.taskId) ?? new Set<string>();
      if (seen.has(url)) return null;
      seen.add(url);
      this.announced.set(event.taskId, seen);
      return { text: `PR opened: ${url}`, status: true };
    }
    return null;
  }

  private sender(): SlackSender | null {
    if (this.options.sender) return this.options.sender;
    const port = this.options.slackPort?.();
    return port ? new SlackSender(port) : null;
  }

  private async auto(task: TaskRow): Promise<boolean> {
    return (await this.options.autoOf?.(task)) ?? false;
  }

  /**
   * An outbound update for a Slack-sourced card whose repository has not turned `conversation.auto` on: a draft on the conversation the card came from
   * (at its root ts, not at `source.ts`), waiting for a tap. A card with no conversation gets a `conversation.undeliverable` event and no draft. A later
   * status never replaces a waiting questions or shipped draft: what a person is looking at is not swapped under them.
   */
  private async outbound(task: TaskRow, kind: DraftKind, text: string, secret = false, given?: SlackItemRow): Promise<void> {
    const { drafts, store } = this.options;
    const body = postable(text);
    if (!body || secret || carriesSecret(text)) return;
    const item = given ?? (drafts && store ? await store.itemByTask(task.id) : null);
    if (!drafts || !item) {
      await this.options.pipeline.record(task.id, "conversation.undeliverable", { kind });
      return;
    }
    const waiting = await drafts.waiting(item.id);
    if (kind === "status" && waiting && (waiting.kind === "questions" || waiting.kind === "shipped")) return;
    await drafts.open({ thread: item.id, channel: item.channel.id, threadTs: item.id.split(":")[1] ?? item.slackTs, kind, text: body, cardId: task.id, private: item.conversation?.private ?? false, records: {} });
    // An outbound draft reopens an item a person had cleared: it now waits for them again.
    if (item.doneAt) await store!.save([{ ...item, doneAt: null, reopenedAt: new Date().toISOString() }]);
  }

  /** Text a model or a person wrote, flattened with `postable`, to the card's own source only: its GitHub issue, or the Slack thread it came
   *  from. Posted only on a person's tap (an event stamped `by: "person"`) or with `conversation.auto: on`; a machine's text is a draft. A card with no
   *  source gets nothing; a Jira ticket is JiraSync's. Text that carries a token is not posted. */
  private async toSource(event: EventRow, text: string, secret = false): Promise<void> {
    const taskId = event.taskId;
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
    const auth: Authority | null = tapOfEvent(event) ?? standingOf({ auto: await this.auto(task) });
    if (!auth) return this.outbound(task, "questions", body);
    const sender = this.sender();
    if (!sender) return;
    const item = this.options.store ? await this.options.store.itemByTask(taskId) : null;
    try {
      await sender.postMessage(auth, source.channel, body, item ? (item.id.split(":")[1] ?? source.ts) : source.ts);
    } catch (error) {
      console.warn(`slack post to the source thread failed for task ${taskId}: ${messageOf(error)}`);
    }
  }

  /** The PR merged: the summary on the issue; with `conversation.auto: on` also in the machine's thread and the source thread; otherwise a shipped draft on the thread the card came from and on each thread attached to it. */
  private async shipped(event: EventRow): Promise<void> {
    const parsed = ShippedEvent.safeParse(event.payload);
    if (!parsed.success) return;
    const text = shippedSummary(parsed.data);
    const task = await this.options.pipeline.get(event.taskId);
    if (fromNotch(task)) return;
    await this.comment(task, text);
    const auto = await this.auto(task);
    if (auto) await this.machineThread(task, text);
    const source = task.source;
    if (source?.kind !== "slack") return;
    if (!auto) {
      await this.outbound(task, "shipped", text);
      // Each thread attached to the card hears of it too, as its own draft (a thread not stored is skipped).
      for (const key of Object.keys(cardOf(task).links)) {
        const match = /^slack:([^:]+):(.+)$/.exec(key);
        const attached = match && this.options.store ? await this.options.store.item(`${match[1]}:${match[2]}`) : null;
        if (attached) await this.outbound(task, "shipped", text, false, attached);
      }
      return;
    }
    const sender = this.sender();
    const standing = standingOf({ auto: true });
    if (!sender || !standing) return;
    const item = this.options.store ? await this.options.store.itemByTask(task.id) : null;
    try {
      await sender.postMessage(standing, source.channel, text, item ? (item.id.split(":")[1] ?? source.ts) : source.ts);
    } catch (error) {
      console.warn(`slack post of the shipped summary failed for task ${event.taskId}: ${messageOf(error)}`);
    }
  }

  /** The task was picked up: a first comment on its issue; with `conversation.auto: on` the root of the machine's Slack thread, otherwise a status draft on the originating thread. */
  private async open(taskId: string): Promise<void> {
    const task = await this.options.pipeline.get(taskId);
    if (fromNotch(task)) return;
    const short = task.id.slice(0, 8);
    await this.comment(task, `Picked up by the pipeline as task #${short}: triage is planning it.`);
    if (!(await this.auto(task))) {
      if (task.source?.kind === "slack") await this.outbound(task, "status", `Picked up by the pipeline: triage is planning it.`);
      return;
    }
    const slack = this.options.slack;
    const sender = this.sender() ?? new SlackSender({} as Slack);
    const standing = standingOf({ auto: true });
    if (!slack || !standing) return;
    const repo = task.repoPath ? ` · ${basename(task.repoPath)}` : "";
    const ts = await sender.botPost(standing, slack, { channel: slack.channel, text: `#${short} ${task.title}${repo}: triage is planning it.` });
    if (!ts) return;
    this.threads.set(taskId, ts);
    await this.options.pipeline.record(taskId, "thread.opened", { kind: "slack", channel: slack.channel, ts });
  }

  private async reply(taskId: string, text: string, status = false): Promise<void> {
    if (text === "__open__") return this.open(taskId);
    const task = await this.options.pipeline.get(taskId);
    if (fromNotch(task)) return;
    await this.comment(task, text);
    if (!(await this.auto(task))) {
      if (task.source?.kind === "slack" && status) await this.outbound(task, "status", text);
      return;
    }
    await this.machineThread(task, text);
  }

  /** A line in the machine-owned Slack thread of a card: only under `conversation.auto: on`. */
  private async machineThread(task: TaskRow, text: string): Promise<void> {
    const slack = this.options.slack;
    const standing = standingOf({ auto: await this.auto(task) });
    if (!slack || !standing) return;
    const ts = await this.threadOf(task.id);
    if (!ts) return;
    const sender = this.sender() ?? new SlackSender({} as Slack);
    await sender.botPost(standing, slack, { channel: slack.channel, thread_ts: ts, text });
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
}
