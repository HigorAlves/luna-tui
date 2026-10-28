// The Slack inbox's poller: everything your Activity tab shows (mentions, DMs, thread replies,
// reactions, broadcasts, watched handles), folded into items, run through the rules file and
// the slack_triage pack in batches, kept in Postgres and published as one snapshot the board
// reads over HTTP and follows on the event stream. A poll persists and publishes what it found
// at once; the pack runs afterwards, one container at a time, and publishes again when its
// verdicts land. The twin of GitHubPulls: same start/stop/pollOnce,
// same publish-only-when-changed rule, same backoff on a rate limit. Acting on an item (reply,
// done, snooze, ticket) lives here too, since each changes what the next poll shows.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  SlackItem,
  SlackItemPatch,
  SlackMetrics,
  SlackPriority,
  SlackSnapshot,
  SlackTaskInput,
  SlackTriage,
  SlackTriageRuns,
  SlackWatch,
  SlackWatchInput,
  SlackWatchPatch,
} from "@hardness/contracts";

import type { SocketEvent, SocketState } from "../adapters/slack/socket-mode.ts";
import { toPlainText } from "../adapters/slack/mrkdwn.ts";
import { stats } from "../adapters/http/metrics.ts";
import {
  type IncomingMessage,
  KEEP_DONE_MS,
  type SlackItemRow,
  compareTs,
  dueOf,
  fold,
  inSnapshot,
  matchWatches,
  mentionsUser,
  prUrlsIn,
  slackTsToDate,
  splitOf,
  toSlackItem,
  touch,
} from "../domain/slack-item.ts";
import { DEFAULT_SLA, RULES_TEMPLATE, type SlaTargets, type SlackRules, applyRules, firstLine, learn, parseRules, withFloor } from "../domain/slack-rules.ts";
import type { TaskRow } from "../domain/task.ts";
import type { NewTask } from "./pipeline.ts";
import { type ChannelInfo, type Conversation, type RawMessage, type Slack, type SlackMe, type Usergroup, messageOf } from "./slack.ts";
import type { SlackStore } from "./slack-store.ts";
import type { TriageItem, Triager } from "./slack-triage.ts";

/** What the HTTP routes need from the inbox; the real class and a test fake both fit. */
export interface SlackInboxPort {
  readonly snapshot: SlackSnapshot;
  pollOnce(): Promise<SlackSnapshot>;
  patch(id: string, patch: SlackItemPatch): Promise<SlackItem>;
  reply(id: string, text: string): Promise<SlackItem>;
  toTask(id: string, input: SlackTaskInput): Promise<TaskRow>;
  watches(): Promise<SlackWatch[]>;
  addWatch(input: SlackWatchInput): Promise<SlackWatch>;
  patchWatch(id: string, patch: SlackWatchPatch): Promise<SlackWatch>;
  deleteWatch(id: string): Promise<void>;
  metrics(since: Date): Promise<SlackMetrics>;
  triageRuns(since: Date): Promise<SlackTriageRuns>;
  digest(): Promise<string>;
  /** For the board's autocomplete; cached ten minutes. */
  usergroups(): Promise<Usergroup[]>;
  channels(): Promise<ChannelInfo[]>;
}

export class NoItemError extends Error {
  constructor(id: string) {
    super(`no Slack item ${id}`);
    this.name = "NoItemError";
  }
}

export class NoWatchError extends Error {
  constructor(id: string) {
    super(`no watch ${id}`);
    this.name = "NoWatchError";
  }
}

export class BuiltinWatchError extends Error {
  constructor(label: string) {
    super(`${label} is built in; switch it off instead of deleting it`);
    this.name = "BuiltinWatchError";
  }
}

export class AlreadyTaskError extends Error {
  constructor(id: string, taskId: string) {
    super(`${id} already became task ${taskId.slice(0, 8)}`);
    this.name = "AlreadyTaskError";
  }
}

export interface SlackInboxOptions {
  slack: Slack;
  /** null: agents off, or no credential or runner image; items stay `triage: null`. */
  triager: Triager | null;
  store: SlackStore;
  intervalMs: number;
  /** Called with the new snapshot when its items, watches, error or socket state changed. */
  publish: (snapshot: SlackSnapshot) => void;
  /** The task an item became, if it still exists. */
  findTask: (taskId: string) => Promise<TaskRow | null>;
  /** The PR inbox's view of a PR named in a message, if it is in there. */
  linkPr: (refs: { repo: string; number: number }[]) => SlackItem["linked"]["pr"];
  createTask: (input: NewTask) => Promise<TaskRow>;
  /** `MACHINE_SLACK_MARK_READ=on`: done also moves your read cursor in Slack. */
  markRead: boolean;
  rulesPath: string;
  /** Non-null: Socket Mode is on; the snapshot reports its state. */
  socketToken: string | null;
  now?: () => Date;
  /** Tests inject a fake file system. */
  files?: { read(path: string): Promise<string | null>; write(path: string, text: string): Promise<void> };
}

const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Items go overdue with no Slack event: the snapshot is recomputed this often. */
const TICK_MS = 60_000;
/** The first poll looks back this far. */
const FIRST_LOOKBACK_MS = DAY_MS;
/** Threads touched this recently are re-read for replies. */
const THREAD_WINDOW_MS = 7 * DAY_MS;
/** `conversations.history` calls one poll may spend on channels nobody flagged. */
const SWEEP_BUDGET = 40;
/** Every Nth poll sweeps channels the socket did not flag. */
const SWEEP_EVERY = 5;
const TRACKED_THREADS = 20;
const LISTING_TTL_MS = 10 * 60_000;
const SEARCH_PAGES = 5;
/** Subtypes that are messages someone wrote, not joins, pins or topic changes. */
const MESSAGE_SUBTYPES = new Set([null, "bot_message", "thread_broadcast", "file_share", "me_message"]);

const BUILTIN_WATCHES: Array<{ value: string; label: string }> = [
  { value: "here", label: "@here" },
  { value: "channel", label: "@channel" },
  { value: "everyone", label: "@everyone" },
];

const toSlackTs = (date: Date): string => (date.getTime() / 1000).toFixed(6);
/** The SLA as the board sees it: 0 stands for "no SLA" on the wire. */
const toWireSla = (sla: SlaTargets): SlackSnapshot["sla"] => ({ P0: sla.P0 ?? 0, P1: sla.P1 ?? 0, P2: sla.P2 ?? 0, P3: sla.P3 ?? 0 });
const key = (row: SlackItemRow): string => (row.kind === "watch" || row.kind === "automated" ? `#${row.channel.name}` : `@${row.author.name}`);

const realFiles: NonNullable<SlackInboxOptions["files"]> = {
  read: (path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error))),
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  },
};

/** What one poll gathered before it is written: changed rows and which of them need triage. */
interface Gathered {
  changed: Map<string, SlackItemRow>;
  pending: Map<string, { floor: SlackPriority | null; settled: SlackTriage | null }>;
}

export class SlackInbox implements SlackInboxPort {
  snapshot: SlackSnapshot = { items: [], watches: [], me: null, polledAt: null, error: null, socket: "off", sla: toWireSla(DEFAULT_SLA) };
  /** How long until the next poll: the interval, or the backoff after a rate limit. */
  nextDelayMs: number;

  private timer: NodeJS.Timeout | undefined;
  private clock: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;
  private stopped = false;
  private polling: Promise<SlackSnapshot> | null = null;
  private me: SlackMe | null = null;
  private sinceTs: string | null = null;
  private polls = 0;
  private warnedNoTriager = false;
  private warnedAuth = false;
  private socketState: SocketState = "disconnected";
  /** Channels a Socket Mode event touched since the last poll. */
  private readonly dirty = new Set<string>();
  /** Reactions the socket reported, folded in by the next poll. */
  private readonly queued: IncomingMessage[] = [];
  /** The latest ts read per channel. */
  private readonly cursors = new Map<string, string>();
  private readonly sweptAt = new Map<string, number>();
  private listings: { usergroups?: { at: number; value: Usergroup[] }; channels?: { at: number; value: ChannelInfo[] } } = {};
  private readonly now: () => Date;
  private readonly files: NonNullable<SlackInboxOptions["files"]>;
  /** The SLA the last refresh read from the rules file; the minute tick recomputes with it. */
  private sla: SlaTargets = DEFAULT_SLA;
  /** Items waiting for the pack, with the floor the rules set; one container runs at a time. */
  private readonly triageQueue = new Map<string, SlackPriority | null>();
  private triaging: Promise<void> | null = null;

  constructor(private readonly options: SlackInboxOptions) {
    this.now = options.now ?? (() => new Date());
    this.files = options.files ?? realFiles;
    this.nextDelayMs = options.intervalMs;
    this.snapshot.socket = options.socketToken ? "disconnected" : "off";
  }

  /** Polls now, then again after each poll's delay; recomputes what is overdue every minute. Never throws. */
  start(): void {
    if (this.timer || this.stopped) return;
    const poll = () => {
      void this.pollOnce()
        .catch((error: unknown) => console.warn("slack inbox: poll failed", error))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(poll, this.nextDelayMs);
          this.timer.unref();
        });
    };
    poll();
    this.clock = setInterval(() => this.tick(), TICK_MS);
    this.clock.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.clock) clearInterval(this.clock);
    if (this.soon) clearTimeout(this.soon);
    this.timer = undefined;
    this.clock = undefined;
  }

  /**
   * The minute tick: an ask goes overdue, a snooze ends, with nothing from Slack to say so.
   * A pure recompute over the snapshot it already holds (no store, no file), published only
   * when a due time, an overdue flag or a split flipped.
   */
  tick(): void {
    const now = this.now();
    const items = this.snapshot.items.map((item) => ({ ...item, ...dueOf(item, now, this.sla), split: splitOf(item, now) }));
    this.publishIfChanged({ ...this.snapshot, items });
  }

  /** One poll; a poll already running is shared rather than doubled. */
  pollOnce(): Promise<SlackSnapshot> {
    if (!this.polling) {
      this.polling = this.poll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  /** A Socket Mode event: the channel is read at the next poll, which comes soon. */
  handleSocketEvent(event: SocketEvent): void {
    if (event.type === "message") {
      this.dirty.add(event.channel);
    } else if (event.type === "reaction_added" && event.item.channel && event.item.ts && this.me && event.item_user === this.me.id) {
      const { channel, ts } = event.item;
      const at = slackTsToDate(event.event_ts);
      this.queued.push({
        id: `${channel}:${ts}`,
        kind: "reaction",
        channel: { id: channel, name: channel, kind: "channel" },
        author: { id: event.user, name: event.user, isBot: false },
        text: `:${event.reaction}: on your message`,
        threadTs: null,
        context: [],
        permalink: "",
        ts: at.toISOString(),
        slackTs: event.event_ts,
        matched: ["reaction"],
      });
    } else {
      return;
    }
    if (this.soon || this.stopped) return;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.pollOnce().catch(() => {});
    }, 3_000);
    this.soon.unref();
  }

  setSocketState(state: SocketState): void {
    this.socketState = state;
    void this.refresh(this.snapshot.polledAt, this.snapshot.error).catch(() => {});
  }

  private async whoAmI(): Promise<SlackMe> {
    if (!this.me) {
      this.me = await this.options.slack.me();
      this.names.set(this.me.id, this.me.name);
    }
    return this.me;
  }

  private async poll(): Promise<SlackSnapshot> {
    const polledAt = this.now().toISOString();
    let error: string | null = null;
    try {
      await this.gather();
      this.nextDelayMs = this.options.intervalMs;
    } catch (thrown) {
      error = messageOf(thrown);
      if (/rate ?limit/i.test(error)) this.nextDelayMs = RATE_LIMIT_BACKOFF_MS;
      if (/auth|token|401/i.test(error)) {
        if (!this.warnedAuth) console.warn(`slack inbox: ${error}`);
        this.warnedAuth = true;
      } else {
        console.warn(`slack inbox: ${error}`);
      }
    }
    const snapshot = await this.refresh(polledAt, error);
    // The pack runs after the poll has published: a container never holds the snapshot back.
    this.kickTriage();
    return snapshot;
  }

  /** Resolves once no triage is in flight or queued. Tests wait on it; the poll never does. */
  async idle(): Promise<void> {
    while (this.triaging) await this.triaging;
  }

  /** Rebuilds the snapshot from the store and the rules file's SLA, and publishes it when it changed. */
  private async refresh(polledAt: string | null, error: string | null): Promise<SlackSnapshot> {
    const now = this.now();
    this.sla = (await this.rules()).sla;
    const rows = await this.options.store.items(new Date(now.getTime() - KEEP_DONE_MS));
    const items = rows
      .filter((row) => inSnapshot(row, now))
      .map((row) => {
        const pr = this.options.linkPr(prUrlsIn(row.text)) ?? row.linked.pr;
        return toSlackItem({ ...row, linked: { ...row.linked, pr } }, now, this.sla);
      });
    const watches = await this.options.store.watches();
    this.publishIfChanged({
      items,
      watches,
      me: this.me ? { ...this.me, isBot: false } : null,
      polledAt,
      error,
      socket: this.options.socketToken ? this.socketState : "off",
      sla: toWireSla(this.sla),
    });
    return this.snapshot;
  }

  /** The one place the snapshot is replaced: the board hears about it only when something it shows changed. */
  private publishIfChanged(next: SlackSnapshot): void {
    const changed =
      JSON.stringify(next.items) !== JSON.stringify(this.snapshot.items) ||
      JSON.stringify(next.watches) !== JSON.stringify(this.snapshot.watches) ||
      JSON.stringify(next.sla) !== JSON.stringify(this.snapshot.sla) ||
      next.error !== this.snapshot.error ||
      next.socket !== this.snapshot.socket;
    this.snapshot = next;
    if (changed) this.options.publish(next);
  }

  /** The rules file, created from the template when it is missing. */
  private async rules(): Promise<SlackRules> {
    let text = await this.files.read(this.options.rulesPath);
    if (text === null) {
      await this.files.write(this.options.rulesPath, RULES_TEMPLATE);
      console.log(`slack inbox: wrote the default rules file to ${this.options.rulesPath}`);
      text = RULES_TEMPLATE;
    }
    return parseRules(text);
  }

  /** The watches, with the three broadcasts seeded on the first run. */
  private async ensureWatches(): Promise<SlackWatch[]> {
    const have = await this.options.store.watches();
    const missing = BUILTIN_WATCHES.filter((b) => !have.some((w) => w.kind === "broadcast" && w.value === b.value));
    for (const b of missing) await this.options.store.addWatch({ kind: "broadcast", value: b.value, label: b.label, channels: [], priority: null, builtin: true });
    return missing.length > 0 ? this.options.store.watches() : have;
  }

  private async gather(): Promise<void> {
    const { slack, store } = this.options;
    const me = await this.whoAmI();
    const watches = await this.ensureWatches();
    const rules = await this.rules();
    const now = this.now();
    const gathered: Gathered = { changed: new Map(), pending: new Map() };
    this.polls++;

    const ingest = async (incoming: IncomingMessage, raw: { text: string; author: SlackItem["author"] }) => {
      const verdict = applyRules(
        {
          author: raw.author,
          text: incoming.text,
          channel: incoming.channel,
          mentionsMe: mentionsUser(raw.text, me.id),
          isOwn: raw.author.id === me.id,
          matched: incoming.matched,
          watches,
        },
        rules,
        now,
      );
      if (verdict.drop) return;
      const existing = gathered.changed.get(incoming.id) ?? (await store.item(incoming.id));
      const { item, retriage } = fold(existing, incoming, now);
      if (retriage) gathered.pending.set(incoming.id, { floor: verdict.floor, settled: verdict.triage });
      if (retriage || item !== existing) gathered.changed.set(incoming.id, item);
    };

    // 1. Mentions, through search, since the last poll's newest hit.
    const since = this.sinceTs ?? (await store.latestTs()) ?? toSlackTs(new Date(now.getTime() - FIRST_LOOKBACK_MS));
    let cursor: string | undefined;
    let newest = since;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const found = await slack.searchMentions(me.id, since, cursor);
      for (const hit of found.hits) {
        if (compareTs(hit.ts, newest) > 0) newest = hit.ts;
        const channel = await this.channelOf(hit.channel.id, hit.channel.name);
        if (rules.muted.includes(channel.id.toLowerCase()) || rules.muted.includes(channel.name.toLowerCase())) continue;
        const threadTs = /[?&]thread_ts=(\d+\.\d+)/.exec(hit.permalink)?.[1] ?? null;
        const author = await this.authorOf(hit.user, null);
        await ingest(
          {
            id: `${channel.id}:${threadTs ?? hit.ts}`,
            kind: "mention",
            channel,
            author,
            text: await this.plain(hit.text),
            threadTs: threadTs === hit.ts ? null : threadTs,
            context: [],
            permalink: hit.permalink,
            ts: slackTsToDate(hit.ts).toISOString(),
            slackTs: hit.ts,
            matched: ["me", ...matchWatches(hit.text, channel.id, watches)],
          },
          { text: hit.text, author },
        );
      }
      if (!found.nextCursor) break;
      cursor = found.nextCursor;
    }
    this.sinceTs = newest;

    // 2. DMs, every poll; 3. channels the socket flagged, plus a rotating slice of the rest.
    const sweep = async (conv: Conversation) => {
      const oldest = this.cursors.get(conv.id) ?? toSlackTs(new Date(now.getTime() - FIRST_LOOKBACK_MS));
      const messages = await slack.history(conv.id, oldest, 100);
      this.sweptAt.set(conv.id, now.getTime());
      for (const m of messages) {
        if (compareTs(m.ts, this.cursors.get(conv.id) ?? oldest) > 0) this.cursors.set(conv.id, m.ts);
        if (!MESSAGE_SUBTYPES.has(m.subtype)) continue;
        if (m.threadTs && m.threadTs !== m.ts && m.subtype !== "thread_broadcast") continue;
        const isDm = conv.kind === "dm" || conv.kind === "mpim";
        const mention = mentionsUser(m.text, me.id);
        const matched = isDm ? ["dm"] : [...(mention ? ["me"] : []), ...matchWatches(m.text, conv.id, watches)];
        if (matched.length === 0) continue;
        const author = await this.authorOf(m.user, m.botId);
        if (author.id === me.id) continue;
        const channel = isDm ? await this.channelOf(conv.id, conv.name) : { id: conv.id, name: conv.name, kind: conv.kind };
        const kind: SlackItem["kind"] = isDm ? "dm" : mention ? "mention" : author.isBot ? "automated" : "watch";
        const threadTs = m.threadTs && m.threadTs !== m.ts ? m.threadTs : null;
        const id = `${conv.id}:${threadTs ?? m.ts}`;
        await ingest(
          {
            id,
            kind,
            channel,
            author,
            text: await this.plain(m.text),
            threadTs,
            context: [],
            permalink: await slack.permalink(conv.id, m.ts).catch(() => ""),
            ts: slackTsToDate(m.ts).toISOString(),
            slackTs: m.ts,
            matched,
          },
          { text: m.text, author },
        );
      }
    };
    for (const dm of await slack.conversations(["im", "mpim"])) await sweep(dm);
    const channels = await this.channels();
    const due = channels.filter((c) => this.dirty.has(c.id));
    this.dirty.clear();
    if (this.polls % SWEEP_EVERY === 1) {
      const rest = channels.filter((c) => !due.includes(c)).sort((a, b) => (this.sweptAt.get(a.id) ?? 0) - (this.sweptAt.get(b.id) ?? 0));
      due.push(...rest.slice(0, Math.max(0, SWEEP_BUDGET - due.length)));
    }
    for (const channel of due) await sweep({ id: channel.id, name: channel.name, kind: channel.kind });

    // 4. Reactions the socket queued.
    for (const reaction of this.queued.splice(0)) {
      const channel = await this.channelOf(reaction.channel.id, reaction.channel.name);
      const author = await this.authorOf(reaction.author.id, null);
      const permalink = await slack.permalink(channel.id, reaction.id.split(":")[1]!).catch(() => "");
      await ingest({ ...reaction, channel, author, text: `${reaction.text} from @${author.name}`, permalink }, { text: "", author });
    }

    // 5. Threads you are in that moved: replies counted, your own reply noticed, context refreshed.
    const stored = await store.items(new Date(now.getTime() - KEEP_DONE_MS));
    const tracked = [...new Map([...stored, ...gathered.changed.values()].map((row) => [row.id, gathered.changed.get(row.id) ?? row])).values()]
      .filter((row) => row.kind !== "reaction" && now.getTime() - new Date(row.ts).getTime() <= THREAD_WINDOW_MS)
      .sort((a, b) => compareTs(b.slackTs, a.slackTs))
      .slice(0, TRACKED_THREADS);
    for (const row of tracked) {
      const threadTs = row.threadTs ?? row.id.split(":")[1]!;
      let replies: RawMessage[];
      try {
        replies = await slack.replies(row.channel.id, threadTs, threadTs);
      } catch (error) {
        console.warn(`slack inbox: replies of ${row.id}: ${messageOf(error)}`);
        continue;
      }
      if (replies.length === 0) continue;
      const latest = replies.at(-1)!;
      const before = replies.filter((r) => compareTs(r.ts, row.slackTs) < 0).slice(-3);
      const context: SlackItem["context"] = [];
      for (const r of before) context.push({ ts: r.ts, user: await this.authorOf(r.user, r.botId), text: await this.plain(r.text) });
      // A reply addressed to you after the latest folded message is a new ask: fold it.
      const asks = replies.filter((r) => compareTs(r.ts, row.slackTs) > 0 && r.user !== me.id && (mentionsUser(r.text, me.id) || matchWatches(r.text, row.channel.id, watches).length > 0 || row.kind === "dm"));
      let current = row;
      for (const ask of asks) {
        const author = await this.authorOf(ask.user, ask.botId);
        const folded = fold(current, { ...current, author, text: await this.plain(ask.text), ts: slackTsToDate(ask.ts).toISOString(), slackTs: ask.ts, matched: [...(mentionsUser(ask.text, me.id) ? ["me"] : []), ...matchWatches(ask.text, row.channel.id, watches), ...(row.kind === "dm" ? ["dm"] : [])], context }, now);
        current = folded.item;
        if (folded.retriage) gathered.pending.set(row.id, { floor: null, settled: null });
      }
      const moved = touch(current, { replies: replies.length, latestIsYours: latest.user === me.id, context }, now);
      if (moved.retriage && !gathered.pending.has(row.id)) gathered.pending.set(row.id, { floor: null, settled: null });
      if (moved.item !== row) gathered.changed.set(row.id, moved.item);
    }

    // 6. Settle what the rules decided and queue the rest for the pack; 7. persist. The pack's
    //    verdicts land in a later publish, so a poll never waits on the container.
    this.settle(gathered);
    const rows = [...gathered.changed.values()].map((row) => ({ ...row, linked: { ...row.linked, pr: this.options.linkPr(prUrlsIn(row.text)) ?? row.linked.pr } }));
    await store.save(rows);
  }

  /** Rules-settled items get their triage now; the others wait for the pack, floor remembered. */
  private settle(gathered: Gathered): void {
    for (const [id, { floor, settled }] of gathered.pending) {
      const row = gathered.changed.get(id);
      if (!row) continue;
      if (settled) {
        gathered.changed.set(id, { ...row, triage: this.keepOverride(row.triage, settled) });
        continue;
      }
      if (!this.options.triager) {
        if (!this.warnedNoTriager) console.warn("slack inbox: no triager (agents off, or no credential or runner image): items are listed without triage");
        this.warnedNoTriager = true;
        continue;
      }
      this.triageQueue.set(id, floor);
    }
  }

  /** Starts a triage run when items wait and none is in flight; the next one starts when it ends. */
  private kickTriage(): void {
    if (this.triaging || this.triageQueue.size === 0 || this.stopped) return;
    this.triaging = this.drainTriage()
      .catch((error: unknown) => console.warn(`slack inbox: triage failed: ${messageOf(error)}`))
      .finally(() => {
        this.triaging = null;
        this.kickTriage();
      });
  }

  /** One pack run over everything queued. */
  private async drainTriage(): Promise<void> {
    const { triager, store } = this.options;
    const queued = new Map(this.triageQueue);
    this.triageQueue.clear();
    if (!triager || queued.size === 0) return;
    const rows = new Map<string, SlackItemRow>();
    for (const id of queued.keys()) {
      const row = await store.item(id);
      if (row) rows.set(id, row);
    }
    if (rows.size === 0) return;
    const [me, watches, rules] = await Promise.all([this.whoAmI(), store.watches(), this.rules()]);
    const toModel: TriageItem[] = [...rows.values()].map((row) => ({
      id: row.id,
      channel: row.channel.kind === "dm" ? `dm with @${row.channel.name}` : `#${row.channel.name}`,
      author: `@${row.author.name}${row.author.isBot ? " (app)" : ""}`,
      text: row.text,
      context: row.context.map((m) => `@${m.user.name}: ${m.text}`),
      matched: row.matched,
      isBot: row.author.isBot,
      threadReplies: row.replies,
    }));
    let answers: Awaited<ReturnType<Triager["triage"]>>;
    try {
      const learned = Object.entries(rules.learned).map(([k, v]) => `- ${k}: ${v.direction} (${v.n})`);
      answers = await triager.triage(toModel, { me: { id: me.id, name: me.name }, notes: rules.notes, learned, vips: rules.vips, watches });
    } catch (error) {
      console.warn(`slack inbox: triage failed: ${messageOf(error)}`);
      answers = new Map();
    }
    const at = this.now().toISOString();
    const fallback = (row: SlackItemRow, why: string): SlackTriage => ({
      priority: "P2",
      category: "fyi",
      expectsReply: false,
      summary: firstLine(row.text),
      why,
      draft: null,
      refs: [],
      deadline: null,
      by: "rules",
      triagedAt: at,
      overridden: false,
    });
    // The container took a while: re-read each row so the verdict lands on what you did meanwhile.
    const saved: SlackItemRow[] = [];
    for (const id of rows.keys()) {
      const row = await store.item(id);
      if (!row) continue;
      const answer = answers.get(id);
      const triage = answer ? { ...answer, by: "model" as const, triagedAt: at, overridden: false } : fallback(row, answers.size === 0 ? "triage did not run" : "the model skipped it");
      saved.push({ ...row, triage: withFloor(this.keepOverride(row.triage, triage), queued.get(id) ?? null) });
    }
    await store.save(saved);
    await this.refresh(this.snapshot.polledAt, this.snapshot.error);
  }

  /** A hand-set priority outlives a re-triage. */
  private keepOverride(previous: SlackTriage | null, next: SlackTriage): SlackTriage {
    return previous?.overridden ? { ...next, priority: previous.priority, overridden: true } : next;
  }

  /** mrkdwn to plain text, with every mentioned user named. */
  private async plain(text: string): Promise<string> {
    for (const [, id] of text.matchAll(/<@([A-Z0-9]+)>/g)) if (!this.names.has(id!)) await this.authorOf(id!, null);
    return toPlainText(text, (id) => this.names.get(id));
  }

  private readonly names = new Map<string, string>();

  private async authorOf(user: string | null, botId: string | null): Promise<SlackItem["author"]> {
    if (user) {
      try {
        const info = await this.options.slack.userInfo(user);
        this.names.set(user, info.name);
        return { id: info.id, name: info.name, isBot: info.isBot };
      } catch {
        return { id: user, name: user, isBot: false };
      }
    }
    return { id: botId ?? "app", name: "app", isBot: true };
  }

  private async channelOf(id: string, fallbackName: string): Promise<SlackItem["channel"]> {
    try {
      const info = await this.options.slack.channelInfo(id);
      if (info.kind === "dm") {
        const other = await this.authorOf(info.name, null);
        return { id, name: other.name, kind: "dm" };
      }
      return { id, name: info.name, kind: info.kind };
    } catch {
      return { id, name: fallbackName, kind: "channel" };
    }
  }

  private async get(id: string): Promise<SlackItemRow> {
    const row = await this.options.store.item(id);
    if (!row) throw new NoItemError(id);
    return row;
  }

  private async saveAndPublish(row: SlackItemRow): Promise<SlackItem> {
    await this.options.store.save([row]);
    const snapshot = await this.refresh(this.snapshot.polledAt, this.snapshot.error);
    return snapshot.items.find((i) => i.id === row.id) ?? toSlackItem(row, this.now(), this.sla);
  }

  /** Writes a learned line; a failure here must not fail the action. */
  private async learnFrom(row: SlackItemRow, direction: "lowered" | "raised"): Promise<void> {
    try {
      const text = (await this.files.read(this.options.rulesPath)) ?? RULES_TEMPLATE;
      await this.files.write(this.options.rulesPath, learn(text, key(row), direction));
    } catch (error) {
      console.warn(`slack inbox: could not update ${this.options.rulesPath}: ${messageOf(error)}`);
    }
  }

  async patch(id: string, patch: SlackItemPatch): Promise<SlackItem> {
    const row = await this.get(id);
    const now = this.now().toISOString();
    let next = row;
    if (patch.done === true && !row.doneAt) {
      next = { ...next, doneAt: now, snoozedUntil: null };
      if (!row.youReplied && !row.repliedAt) await this.learnFrom(row, "lowered");
      if (this.options.markRead) {
        try {
          await this.options.slack.mark(row.channel.id, row.slackTs);
        } catch (error) {
          console.warn(`slack inbox: conversations.mark failed: ${messageOf(error)}`);
        }
      }
    } else if (patch.done === false) {
      next = { ...next, doneAt: null, reopenedAt: null };
    }
    if (patch.snoozedUntil !== undefined) next = { ...next, snoozedUntil: patch.snoozedUntil };
    if (patch.seen) next = { ...next, seenAt: next.seenAt ?? now };
    if (patch.priority) {
      const base: SlackTriage = next.triage ?? { priority: patch.priority, category: "fyi", expectsReply: false, summary: firstLine(next.text), why: "set by hand", draft: null, refs: [], deadline: null, by: "rules", triagedAt: now, overridden: true };
      next = { ...next, triage: { ...base, priority: patch.priority, overridden: true } };
    }
    return this.saveAndPublish(next);
  }

  async reply(id: string, text: string): Promise<SlackItem> {
    const row = await this.get(id);
    await this.options.slack.postMessage(row.channel.id, text, row.threadTs ?? row.slackTs);
    const now = this.now();
    if (now.getTime() - new Date(row.arrivedAt).getTime() < HOUR_MS) await this.learnFrom(row, "raised");
    return this.saveAndPublish({ ...row, doneAt: now.toISOString(), youReplied: true, repliedAt: now.toISOString(), snoozedUntil: null });
  }

  async toTask(id: string, input: SlackTaskInput): Promise<TaskRow> {
    const row = await this.get(id);
    if (row.linked.taskId && (await this.options.findTask(row.linked.taskId))) throw new AlreadyTaskError(id, row.linked.taskId);
    const where = row.channel.kind === "dm" ? `DM with @${row.channel.name}` : `#${row.channel.name}`;
    const context = row.context.map((m) => `> @${m.user.name}: ${m.text.replace(/\n/g, "\n> ")}`);
    const description = [
      `From Slack: @${row.author.name} in ${where}${row.permalink ? ` · ${row.permalink}` : ""}`,
      "",
      ...(context.length > 0 ? [...context, ">"] : []),
      `> @${row.author.name}: ${row.text.replace(/\n/g, "\n> ")}`,
    ].join("\n");
    const task = await this.options.createTask({
      title: input.title ?? row.triage?.summary ?? firstLine(row.text),
      description,
      repoPath: input.repoPath ?? null,
      source: { kind: "slack", channel: row.channel.id, ts: row.slackTs, permalink: row.permalink },
    });
    await this.saveAndPublish({ ...row, linked: { ...row.linked, taskId: task.id } });
    return task;
  }

  async watches(): Promise<SlackWatch[]> {
    return this.ensureWatches();
  }

  async addWatch(input: SlackWatchInput): Promise<SlackWatch> {
    let label = input.label;
    if (!label) {
      if (input.kind === "usergroup") label = `@${(await this.usergroups().catch(() => [])).find((g) => g.id === input.value)?.handle ?? input.value}`;
      else if (input.kind === "channel") label = `#${await this.options.slack.channelInfo(input.value).then((c) => c.name, () => input.value)}`;
      else if (input.kind === "broadcast") label = `@${input.value}`;
      else label = input.value;
    }
    const watch = await this.options.store.addWatch({ ...input, label });
    await this.refresh(this.snapshot.polledAt, this.snapshot.error);
    return watch;
  }

  async patchWatch(id: string, patch: SlackWatchPatch): Promise<SlackWatch> {
    const watch = await this.options.store.patchWatch(id, patch);
    if (!watch) throw new NoWatchError(id);
    await this.refresh(this.snapshot.polledAt, this.snapshot.error);
    return watch;
  }

  async deleteWatch(id: string): Promise<void> {
    const watch = (await this.options.store.watches()).find((w) => w.id === id);
    if (!watch) throw new NoWatchError(id);
    if (watch.builtin) throw new BuiltinWatchError(watch.label);
    await this.options.store.deleteWatch(id);
    await this.refresh(this.snapshot.polledAt, this.snapshot.error);
  }

  async metrics(since: Date): Promise<SlackMetrics> {
    const [rows, { sla }] = await Promise.all([this.options.store.metricRows(since), this.rules()]);
    const zero = (): Record<SlackPriority, number> => ({ P0: 0, P1: 0, P2: 0, P3: 0 });
    const items = zero();
    const replied = zero();
    const withinSla = zero();
    const seconds: Record<SlackPriority, number[]> = { P0: [], P1: [], P2: [], P3: [] };
    let withinHour = 0;
    const days = new Map<string, { items: number; replied: number }>();
    for (const row of rows) {
      const day = row.arrivedAt.slice(0, 10);
      const d = days.get(day) ?? { items: 0, replied: 0 };
      d.items++;
      if (row.priority) items[row.priority]++;
      if (row.repliedAt) {
        d.replied++;
        const s = (new Date(row.repliedAt).getTime() - new Date(row.ts).getTime()) / 1000;
        if (s < 3600) withinHour++;
        if (row.priority) {
          if (row.expectsReply) {
            replied[row.priority]++;
            const target = sla[row.priority];
            if (target !== null && s <= target) withinSla[row.priority]++;
          }
          seconds[row.priority].push(s);
        }
      }
      days.set(day, d);
    }
    return {
      since: since.toISOString(),
      items,
      replied,
      withinHour,
      withinSla,
      sla: toWireSla(sla),
      timeToReply: { P0: stats(seconds.P0), P1: stats(seconds.P1), P2: stats(seconds.P2), P3: stats(seconds.P3) },
      byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d })),
    };
  }

  /** `GET /slack/triage-runs`: the pack's runs since `since`, with the items and cost summed. */
  async triageRuns(since: Date): Promise<SlackTriageRuns> {
    const runs = await this.options.store.triageRuns(since);
    const items = runs.reduce((sum, run) => sum + run.items, 0);
    const costUsd = Math.round(runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) * 10_000) / 10_000;
    return { since: since.toISOString(), runs, items, costUsd };
  }

  /** The ten-line morning text: what is overdue, open P0/P1, what waits on others, yesterday's response time. */
  async digest(): Promise<string> {
    const now = this.now();
    const { sla } = await this.rules();
    const rows = (await this.options.store.items(new Date(now.getTime() - KEEP_DONE_MS))).map((row) => ({ row, split: splitOf(row, now) }));
    const overdue = rows.filter(({ row }) => dueOf(row, now, sla).overdue).length;
    const line = (r: SlackItemRow) => `- ${r.triage?.priority ?? "P?"} #${r.channel.name} @${r.author.name}: ${r.triage?.summary ?? firstLine(r.text, 60)}`;
    const urgent = rows.filter(({ row, split }) => split === "needs_reply" && (row.triage?.priority === "P0" || row.triage?.priority === "P1")).map(({ row }) => row);
    const waiting = rows.filter(({ split }) => split === "waiting_on_them").map(({ row }) => row);
    const needs = rows.filter(({ split }) => split === "needs_reply").length;
    const yesterday = await this.metrics(new Date(now.getTime() - DAY_MS));
    const all = Object.values(yesterday.timeToReply).flatMap((s) => (s.median === null ? [] : [s.median]));
    const median = all.length > 0 ? Math.round(all.reduce((a, b) => a + b, 0) / all.length / 60) : null;
    const total = Object.values(yesterday.items).reduce((a, b) => a + b, 0);
    return [
      `Slack inbox · ${now.toISOString().slice(0, 10)}`,
      ...(overdue > 0 ? [`${overdue} overdue now`] : []),
      `Needs reply: ${needs} (${urgent.length} at P0/P1)`,
      ...urgent.slice(0, 4).map(line),
      `Waiting on them: ${waiting.length}`,
      ...waiting.slice(0, 2).map(line),
      `Last 24h: ${total} item(s), ${yesterday.withinHour} answered within the hour${median === null ? "" : `, median reply ${median} min`}`,
    ].join("\n");
  }

  /** Posts the digest to your own DM. */
  async postDigest(): Promise<void> {
    const me = await this.whoAmI();
    const channel = await this.options.slack.openDm(me.id);
    await this.options.slack.postMessage(channel, await this.digest());
  }

  async usergroups(): Promise<Usergroup[]> {
    const cached = this.listings.usergroups;
    if (cached && this.now().getTime() - cached.at < LISTING_TTL_MS) return cached.value;
    const value = await this.options.slack.usergroups();
    this.listings.usergroups = { at: this.now().getTime(), value };
    return value;
  }

  async channels(): Promise<ChannelInfo[]> {
    const cached = this.listings.channels;
    if (cached && this.now().getTime() - cached.at < LISTING_TTL_MS) return cached.value;
    const value = await this.options.slack.conversations(["public_channel", "private_channel"]);
    this.listings.channels = { at: this.now().getTime(), value };
    return value;
  }
}
