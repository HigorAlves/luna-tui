// The Slack port over the Web API with plain `fetch`: one POST per method against
// slack.com/api, your user token as a Bearer, form-encoded arguments (JSON where Slack
// prefers it). `ok: false` throws Slack's own `error` word; a 429 waits for `Retry-After`
// once when it is short (5s at most), else throws a message the poller recognises as a rate limit. Users and channels are
// cached for the process's life: names do not change by the minute.
import { z } from "zod";

import {
  type ChannelInfo,
  type Conversation,
  type ConversationType,
  type RawMessage,
  type SearchPage,
  type Slack,
  SlackError,
  type UserInfo,
  type Usergroup,
} from "../../application/slack.ts";

export interface WebApiOptions {
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  /** Waits for a 429's `Retry-After`; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
}

const API = "https://slack.com/api";
const PAGE = 200;
/** How many pages one listing call walks before giving up on a huge workspace. */
const MAX_PAGES = 20;
/** The longest `Retry-After` waited out inline; past it the call fails as a rate limit and the poller backs off. */
const MAX_RETRY_WAIT_MS = 5_000;

const Ok = z.object({ ok: z.literal(true) }).passthrough();
const Failed = z.object({ ok: z.literal(false), error: z.string().optional() });

const Message = z.object({
  ts: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().default(""),
  subtype: z.string().optional(),
  thread_ts: z.string().optional(),
  reply_count: z.number().optional(),
  latest_reply: z.string().optional(),
});

const Channel = z.object({
  id: z.string(),
  name: z.string().optional(),
  user: z.string().optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_private: z.boolean().optional(),
});

const Meta = z.object({ response_metadata: z.object({ next_cursor: z.string().optional() }).optional() });

function toConversation(c: z.infer<typeof Channel>): Conversation {
  const kind = c.is_im ? "dm" : c.is_mpim ? "mpim" : c.is_private ? "group" : "channel";
  return { id: c.id, name: c.name ?? c.user ?? c.id, kind };
}

function toMessage(m: z.infer<typeof Message>): RawMessage {
  return {
    ts: m.ts,
    user: m.user ?? null,
    botId: m.bot_id ?? null,
    text: m.text,
    subtype: m.subtype ?? null,
    threadTs: m.thread_ts ?? null,
    replyCount: m.reply_count ?? 0,
    latestReply: m.latest_reply ?? null,
  };
}

/** `YYYY-MM-DD` of the day before `ts`, for search's day-granular `after:` filter. */
function dayBefore(ts: string): string {
  const at = new Date(Number(ts) * 1000 - 86_400_000);
  return at.toISOString().slice(0, 10);
}

export function createSlack(token: string, options: WebApiOptions = {}): Slack {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const users = new Map<string, Promise<UserInfo>>();
  const channels = new Map<string, Promise<ChannelInfo>>();

  async function call<T extends z.ZodType>(method: string, params: Record<string, string | number | boolean | undefined>, shape: T, as: { token?: string; json?: boolean } = {}): Promise<z.infer<T>> {
    const body = as.json
      ? JSON.stringify(params)
      : new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString();
    const request = (): Promise<Response> =>
      doFetch(`${API}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${as.token ?? token}`,
          "Content-Type": as.json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
        },
        body,
      });
    let response = await request();
    if (response.status === 429) {
      const after = Number(response.headers.get("Retry-After") ?? "1");
      const waitMs = (Number.isFinite(after) ? after : 1) * 1000;
      if (waitMs > MAX_RETRY_WAIT_MS) throw new SlackError(`Slack rate limit on ${method}: retry after ${after}s`);
      await sleep(waitMs);
      response = await request();
      if (response.status === 429) throw new SlackError(`Slack rate limit on ${method}: retry after ${after}s`);
    }
    if (!response.ok) throw new SlackError(`${method} answered HTTP ${response.status}`);
    const json: unknown = await response.json();
    const failed = Failed.safeParse(json);
    if (failed.success) {
      const word = failed.data.error ?? "unknown_error";
      throw new SlackError(word === "ratelimited" ? `Slack rate limit on ${method} (ratelimited)` : `${method}: ${word}`);
    }
    const parsed = Ok.and(shape).safeParse(json);
    if (!parsed.success) throw new SlackError(`${method}: unexpected answer: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  /** Every page of a cursor-paginated listing. */
  async function pages<T>(method: string, params: Record<string, string | number>, shape: z.ZodType<{ items: T[]; next: string | null }>): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await call(method, { ...params, limit: PAGE, cursor }, shape);
      all.push(...answer.items);
      if (!answer.next) break;
      cursor = answer.next;
    }
    return all;
  }

  const ConversationsPage = Meta.extend({ channels: z.array(Channel) }).transform((a) => ({ items: a.channels.map(toConversation), next: a.response_metadata?.next_cursor || null }));
  const MessagesPage = z.object({ messages: z.array(Message) });

  return {
    async me() {
      const a = await call("auth.test", {}, z.object({ user_id: z.string(), user: z.string() }));
      return { id: a.user_id, name: a.user };
    },

    async searchMentions(userId, oldestTs, cursor) {
      const a = await call(
        "search.messages",
        { query: `<@${userId}> after:${dayBefore(oldestTs)}`, sort: "timestamp", sort_dir: "asc", count: 100, cursor: cursor ?? "*" },
        z.object({
          messages: z.object({
            matches: z.array(z.object({ ts: z.string(), text: z.string().default(""), user: z.string().optional(), channel: z.object({ id: z.string(), name: z.string().optional() }), permalink: z.string().default("") })),
          }),
          response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
        }),
      );
      const hits = a.messages.matches
        .filter((m) => Number(m.ts) > Number(oldestTs))
        .map((m) => ({ ts: m.ts, text: m.text, user: m.user ?? null, channel: { id: m.channel.id, name: m.channel.name ?? m.channel.id }, permalink: m.permalink }));
      return { hits, nextCursor: a.response_metadata?.next_cursor || null } satisfies SearchPage;
    },

    conversations(types: ConversationType[]) {
      // Channels come from users.conversations (what you are in); DMs from conversations.list.
      const dms = types.every((t) => t === "im" || t === "mpim");
      return pages(dms ? "conversations.list" : "users.conversations", { types: types.join(","), exclude_archived: "true" }, ConversationsPage);
    },

    async history(channel, oldest, limit) {
      const a = await call("conversations.history", { channel, oldest, limit, inclusive: false }, MessagesPage);
      return a.messages.map(toMessage).reverse();
    },

    async replies(channel, threadTs, oldest) {
      const a = await call("conversations.replies", { channel, ts: threadTs, oldest, limit: PAGE, inclusive: false }, MessagesPage);
      return a.messages
        .filter((m) => m.ts !== threadTs && Number(m.ts) > Number(oldest))
        .map(toMessage)
        .sort((x, y) => Number(x.ts) - Number(y.ts));
    },

    async usergroups() {
      const a = await call("usergroups.list", {}, z.object({ usergroups: z.array(z.object({ id: z.string(), handle: z.string(), name: z.string() })) }));
      return a.usergroups.map((g): Usergroup => ({ id: g.id, handle: g.handle, name: g.name }));
    },

    userInfo(id) {
      let cached = users.get(id);
      if (!cached) {
        cached = call(
          "users.info",
          { user: id },
          z.object({ user: z.object({ id: z.string(), name: z.string(), real_name: z.string().optional(), is_bot: z.boolean().optional(), profile: z.object({ display_name: z.string().optional() }).optional() }) }),
        ).then(
          (a) => ({ id: a.user.id, name: a.user.profile?.display_name || a.user.real_name || a.user.name, isBot: a.user.is_bot ?? false }),
          (error: unknown) => {
            users.delete(id);
            throw error;
          },
        );
        users.set(id, cached);
      }
      return cached;
    },

    channelInfo(id) {
      let cached = channels.get(id);
      if (!cached) {
        cached = call("conversations.info", { channel: id }, z.object({ channel: Channel })).then(
          (a) => toConversation(a.channel),
          (error: unknown) => {
            channels.delete(id);
            throw error;
          },
        );
        channels.set(id, cached);
      }
      return cached;
    },

    async permalink(channel, ts) {
      const a = await call("chat.getPermalink", { channel, message_ts: ts }, z.object({ permalink: z.string() }));
      return a.permalink;
    },

    async postMessage(channel, text, threadTs) {
      const a = await call("chat.postMessage", { channel, text, thread_ts: threadTs }, z.object({ ts: z.string() }), { json: true });
      return a.ts;
    },

    async mark(channel, ts) {
      await call("conversations.mark", { channel, ts }, z.object({}), { json: true });
    },

    async openDm(userId) {
      const a = await call("conversations.open", { users: userId }, z.object({ channel: z.object({ id: z.string() }) }), { json: true });
      return a.channel.id;
    },

    async openSocket(appToken) {
      const a = await call("apps.connections.open", {}, z.object({ url: z.string() }), { token: appToken });
      return a.url;
    },
  };
}
