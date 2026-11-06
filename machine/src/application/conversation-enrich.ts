// The conversation's enrichment, by script and through the existing ports: the thread as lines, the author's profile and the
// candidates (the cards and backlog items its channel can already see, shortlisted by similarity). Every text is masked
// (e-mail addresses, phone numbers), flattened to one line and capped before it can reach a prompt; every port read is bounded
// and a failing port is an empty answer. A model never fetches anything: it judges what this builds.
import { type ConversationContext, MESSAGE_CAPS, type TaskSource } from "@hardness/contracts";

import { type Candidate, similar } from "../domain/similarity.ts";
import { maskPii } from "../domain/secrets-check.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import type { UserInfo } from "./slack.ts";

export type TicketMark = { kind: "jira" | "github"; key: string };

export interface EnrichDeps {
  userInfo(id: string): Promise<UserInfo>;
  /** The rules file's VIPs. */
  isVip(author: { id: string; name: string }): boolean;
  /** `Pipeline.ticketCandidates`: only what the thread's own source can already see; no repository, none. */
  candidates(repo: string | null, source: TaskSource): Promise<Candidate[]>;
  /** `Pipeline.claimedRepoCandidates`: the repository's ticket-sourced cards, asked for only in a channel it claims. */
  claimedCandidates(repo: string): Promise<Array<Candidate & { otherSource: TicketMark }>>;
  /** The repository whose `luna.yaml` lists the channel (`ChannelClaims.repoOf`). */
  claimedBy(channel: string): string | null;
}

export interface ShortlistEntry {
  slot: number;
  id: string;
  kind: "open" | "closed" | "backlog";
  /** Where a ticket-sourced card came from; null for a card the channel could see anyway. The board says so before the tap. */
  otherSource: TicketMark | null;
}

export interface Enriched {
  context: ConversationContext;
  /** The ids behind the slots: targets come only from here, never from anything a message names. */
  shortlist: ShortlistEntry[];
}

const LOOKBACK_DAYS = 90;
const flat = (text: string, cap: number): string => maskPii(text).replace(/\s+/g, " ").trim().slice(0, cap);

export async function enrichConversation(row: SlackItemRow, deps: EnrichDeps, now: Date): Promise<Enriched> {
  const conversation = row.conversation;
  const history = (conversation?.history ?? []).filter((m) => !m.deleted && m.text !== "").slice(-MESSAGE_CAPS.history);
  const thread = history.map((m) => `${flat(m.author.name, 100)}: ${flat(m.text, 500)}`);
  const latest = flat(history.at(-1)?.text ?? row.text, 500);

  const info = await deps.userInfo(row.author.id).catch(() => null);
  const profile = info?.isBot || row.author.isBot ? "bot" : info?.isGuest ? "guest" : deps.isVip(row.author) ? "vip" : "member";
  const title = info?.title ? flat(info.title, 120) : null;

  const repo = conversation?.repo ?? null;
  const source: TaskSource = { kind: "slack", channel: row.channel.id, ts: row.threadTs ?? row.slackTs, permalink: row.permalink };
  const own = repo ? await deps.candidates(repo, source).catch((): Candidate[] => []) : [];
  const claimed = repo && !conversation?.private && deps.claimedBy(row.channel.id) === repo ? await deps.claimedCandidates(repo).catch(() => []) : [];
  const marks = new Map(claimed.map((c) => [c.id, c.otherSource]));
  const pool = [...new Map([...own, ...claimed].map((c) => [c.id, c])).values()];

  const near = similar({ title: row.text.split("\n")[0] ?? "", text: thread.join(" "), repo }, pool, { now, lookbackDays: LOOKBACK_DAYS }).slice(0, 5);
  const byId = new Map(pool.map((c) => [c.id, c]));
  const shortlist: ShortlistEntry[] = [];
  const candidates: ConversationContext["candidates"] = [];
  for (const n of near) {
    const c = byId.get(n.id)!;
    const slot = shortlist.length + 1;
    shortlist.push({ slot, id: c.id, kind: c.kind, otherSource: marks.get(c.id) ?? null });
    candidates.push({ slot, kind: c.kind, title: flat(c.title, 500), summary: flat(c.text, 1000) });
  }
  return { context: { channel: flat(row.channel.name, 120), private: conversation?.private ?? row.channel.kind !== "channel", thread, latest, author: { profile, title }, candidates }, shortlist };
}
