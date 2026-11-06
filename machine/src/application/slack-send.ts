// The only door out of the machine into Slack. Every write (a post, a read mark, a DM opened, and the bot token's own `chat.postMessage`) goes through
// `SlackSender`, and every method needs an authority that only a person's tap or a named standing switch can produce:
//  - a `Tap`, from `tapOf(route)` (called only in the HTTP adapter) or `tapOfEvent(event)` (an event whose payload says `by: "person"`);
//  - a `Standing`, from `standingOf(...)`: only `conversation.auto: on` (a repository's luna.yaml) or the operator's own `MACHINE_SLACK_DIGEST_AT`.
// A poll, a clock, an event handler and a retry hold none of these and cannot call a writing method. A text that carries a secret-shaped string is refused.
import { carriesSecret } from "../domain/postable.ts";
import type { Slack } from "./slack.ts";

declare const authority: unique symbol;
export interface Tap {
  readonly [authority]: "tap";
  readonly route: string;
}
export interface Standing {
  readonly [authority]: "standing";
  readonly reason: "auto" | "digest";
}
export type Authority = Tap | Standing;

/** The reads of the Slack port: what a poll, a clock or an event handler may hold. */
export type SlackReads = Omit<Slack, "postMessage" | "mark" | "openDm">;

/** Text the machine will not send: it carries something shaped like a secret (HTTP 409 `slack_refused`). */
export class SlackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackRefusedError";
  }
}

/** A person's tap on an HTTP route. Called only in `adapters/http/app.ts`. */
export const tapOf = (route: string): Tap => ({ route }) as Tap;

/** A person's tap read from a logged event whose payload says `by: "person"`; null for anything else. Called only in `threads.ts`. */
export const tapOfEvent = (event: { kind: string; payload: Record<string, unknown> }): Tap | null => (event.payload.by === "person" ? ({ route: `event ${event.kind}` } as Tap) : null);

/** The two standing switches, each off by default: a repository's `conversation.auto: on`, and the operator's `MACHINE_SLACK_DIGEST_AT`. Called only in `threads.ts` and `slack-inbox.ts`. */
export const standingOf = (switches: { auto?: boolean; digest?: boolean }): Standing | null => (switches.auto ? ({ reason: "auto" } as Standing) : switches.digest ? ({ reason: "digest" } as Standing) : null);

export interface WriteRecord {
  method: "postMessage" | "mark" | "openDm" | "botPost";
  channel: string;
  /** The tap's route, or the standing switch's name. */
  by: string;
}

export class SlackSender {
  /** What was written and under which authority, the last hundred (the tap test reads it). */
  readonly writes: WriteRecord[] = [];

  constructor(private readonly port: Slack) {}

  private record(auth: Authority, method: WriteRecord["method"], channel: string): void {
    this.writes.push({ method, channel, by: "route" in auth ? auth.route : auth.reason });
    if (this.writes.length > 100) this.writes.shift();
  }

  /** Posts as the operator. */
  async postMessage(auth: Authority, channel: string, text: string, ...thread: [] | [threadTs: string | undefined]): Promise<string> {
    if (carriesSecret(text)) throw new SlackRefusedError("the text carries something shaped like a secret, so it was not sent");
    this.record(auth, "postMessage", channel);
    return this.port.postMessage(channel, text, ...(thread as [string?]));
  }

  async mark(auth: Authority, channel: string, ts: string): Promise<void> {
    this.record(auth, "mark", channel);
    await this.port.mark(channel, ts);
  }

  async openDm(auth: Authority, userId: string): Promise<string> {
    this.record(auth, "openDm", userId);
    return this.port.openDm(userId);
  }

  /** The bot token's `chat.postMessage` (the machine-owned thread of `conversation.auto: on`): the message's ts, or null (logged). */
  async botPost(auth: Authority, bot: { token: string; fetch?: typeof fetch }, body: { channel: string; text: string; thread_ts?: string }): Promise<string | null> {
    if (carriesSecret(body.text)) throw new SlackRefusedError("the text carries something shaped like a secret, so it was not sent");
    this.record(auth, "botPost", body.channel);
    const response = await (bot.fetch ?? fetch)("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.token}`, "Content-Type": "application/json; charset=utf-8" },
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
