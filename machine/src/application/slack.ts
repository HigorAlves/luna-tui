// The Slack port: everything the inbox asks Slack, as typed calls over your user token. The
// Web API adapter implements it; tests pass a fake. Every method throws a `SlackError` with
// Slack's own `error` string when a call fails; the poller reports it and backs off on a
// rate limit. The task-thread replies in threads.ts keep their own bot token and stay apart.

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackError";
  }
}

export interface SlackMe {
  id: string;
  name: string;
}

/** One hit of `search.messages`. */
export interface SearchHit {
  ts: string;
  text: string;
  /** The author's user id; null for an app without one. */
  user: string | null;
  channel: { id: string; name: string };
  permalink: string;
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
}

export type ConversationType = "public_channel" | "private_channel" | "im" | "mpim";

export interface Conversation {
  id: string;
  /** The channel's name; for a DM, the other person's id. */
  name: string;
  kind: "channel" | "group" | "dm" | "mpim";
}

/** One message of `conversations.history` / `conversations.replies`. */
export interface RawMessage {
  ts: string;
  user: string | null;
  botId: string | null;
  text: string;
  subtype: string | null;
  threadTs: string | null;
  replyCount: number;
  /** The ts of the latest reply, when Slack says. */
  latestReply: string | null;
}

export interface Usergroup {
  id: string;
  /** Without the `@`. */
  handle: string;
  name: string;
}

export interface UserInfo {
  id: string;
  name: string;
  isBot: boolean;
}

export interface ChannelInfo {
  id: string;
  name: string;
  kind: Conversation["kind"];
}

export interface Slack {
  /** Who the token belongs to. */
  me(): Promise<SlackMe>;
  /** Messages mentioning `<@userId>` after `oldestTs`, oldest first; `cursor` continues a page. */
  searchMentions(userId: string, oldestTs: string, cursor?: string): Promise<SearchPage>;
  /** The conversations you are in, of these types, every page. */
  conversations(types: ConversationType[]): Promise<Conversation[]>;
  /** Messages after `oldest` (exclusive), oldest first. */
  history(channel: string, oldest: string, limit: number): Promise<RawMessage[]>;
  /** The thread's replies after `oldest` (exclusive), oldest first; the parent is left out. */
  replies(channel: string, threadTs: string, oldest: string): Promise<RawMessage[]>;
  usergroups(): Promise<Usergroup[]>;
  /** Cached by the adapter. */
  userInfo(id: string): Promise<UserInfo>;
  /** Cached by the adapter. */
  channelInfo(id: string): Promise<ChannelInfo>;
  permalink(channel: string, ts: string): Promise<string>;
  /** Posts as you; answers the new message's ts. */
  postMessage(channel: string, text: string, threadTs?: string): Promise<string>;
  /** Moves your read cursor in Slack itself. */
  mark(channel: string, ts: string): Promise<void>;
  /** The DM channel with `userId`, opened if need be. */
  openDm(userId: string): Promise<string>;
  /** The websocket url for Socket Mode, from the app-level token. */
  openSocket(appToken: string): Promise<string>;
}

/** No user token is set: nothing can be read or posted. The reply route answers 409 `no_token`. */
export class NoSlackTokenError extends SlackError {
  constructor() {
    super("no Slack user token: set MACHINE_SLACK_USER_TOKEN (xoxp-…) for the inbox");
    this.name = "NoSlackTokenError";
  }
}

/** The port with no token behind it: every call fails with the same clear reason. */
export function noTokenSlack(): Slack {
  const refuse = () => Promise.reject(new NoSlackTokenError());
  return {
    me: refuse,
    searchMentions: refuse,
    conversations: refuse,
    history: refuse,
    replies: refuse,
    usergroups: refuse,
    userInfo: refuse,
    channelInfo: refuse,
    permalink: refuse,
    postMessage: refuse,
    mark: refuse,
    openDm: refuse,
    openSocket: refuse,
  };
}

export { messageOf } from "./github.ts";
