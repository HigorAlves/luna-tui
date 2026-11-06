// The reply draft of a thread, written after the relation: the card's state, its Evidence Pack summary and the repository's docs as data, one run of the
// `conversation_reply` pack (no tools, one answer). Nothing here posts: the text is stored as the draft and a person's tap sends it.
// A card's part is built only when the relation's target is a card in the thread's own stored shortlist (what its channel could see), never from a message.
import type { ConversationContext } from "@hardness/contracts";

import { domainTokens, holdsForeignAddress } from "../domain/address-rule.ts";
import { carriesSecret, postableKeeping } from "../domain/postable.ts";
import { maskPii } from "../domain/secrets-check.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";

export interface CardView {
  /** The state in fixed words. */
  state: string;
  title: string;
  /** The PR's address, when the machine has one. */
  pr: string | null;
  /** Results by verdict, resolutions and the preview address, already summarised by script; never a local path, the plan, a finding's text or the Triage Record. */
  evidence: string | null;
}

export interface DraftDeps {
  card(id: string): Promise<CardView | null>;
  /** Where a backlog item ranks, in words ("ranks 4th of 12"). */
  rank(id: string): Promise<string | null>;
  docs(repo: string, text: string): Promise<string[]>;
  /** The channel's notes for tone (the rules file's Notes), and later its past edits. */
  tone(channel: string, isPrivate: boolean): Promise<Array<{ machine: string; person: string }>>;
  /** The one run of the `conversation_reply` pack. */
  run(context: ConversationContext): Promise<{ reply: string; confidence: number }>;
}

export const ADDRESS_REFUSED = "the reply held an address, so it was not kept";
const KINDS_WITHOUT_REPLY = new Set(["fyi", "chatter"]);
const flat = (text: string, cap: number): string => maskPii(text).replace(/\s+/g, " ").trim().slice(0, cap);

export class ConversationDrafter {
  constructor(private readonly deps: DraftDeps) {}

  /** The draft text, or null when none is due, the answer carried a secret, or it held an address the machine did not give (`onRefused` says why in fixed words). A failed run throws (the inbox retries). */
  async draft(row: SlackItemRow, onRefused?: (why: string) => void): Promise<string | null> {
    const c = row.conversation;
    const relation = c?.relation;
    if (!c || !relation || relation.type === "ask" || !c.classification) return null;
    if (c.classification.verdict === "ask" || !row.triage?.expectsReply || KINDS_WITHOUT_REPLY.has(c.classification.kind)) return null;
    const history = c.history.filter((m) => !m.deleted && m.text !== "").slice(-20);
    const entry = relation.target ? (c.shortlist ?? []).find((e) => e.id === relation.target) : undefined;
    let card: string | null = null;
    let evidence: string | null = null;
    // The only addresses a draft may hold: the ones the machine itself put into the context.
    const given = new Set<string>();
    if (entry && entry.kind !== "backlog" && relation.type === "related_to_in_progress") {
      const view = await this.deps.card(entry.id).catch(() => null);
      if (view) {
        if (view.pr) given.add(view.pr);
        card = flat(`State: ${view.state}. Title: ${view.title}.${view.pr ? ` PR: ${view.pr}` : ""}`, 2000);
        evidence = view.evidence ? flat(view.evidence, 2000) : null;
      }
    } else if (entry && entry.kind === "backlog") {
      const rank = await this.deps.rank(entry.id).catch(() => null);
      card = flat(`It is queued in the backlog${rank ? `; ${rank}` : ""}.`, 2000);
    }
    const docs = c.repo ? await this.deps.docs(c.repo, history.map((m) => m.text).join(" ")).catch(() => []) : [];
    const tone = await this.deps.tone(row.channel.id, c.private).catch(() => []);
    const context: ConversationContext = {
      channel: flat(row.channel.name, 120),
      private: c.private,
      thread: history.map((m) => `${flat(m.author.name, 100)}: ${flat(m.text, 500)}`),
      latest: flat(history.at(-1)?.text ?? row.text, 500),
      author: { profile: row.author.isBot ? "bot" : "member", title: null },
      candidates: [],
      reply: { relation: relation.type, card, evidence, docs: docs.map((d) => flat(d, 1500)).slice(0, 3), tone: tone.slice(0, 5).map((t) => ({ machine: flat(t.machine, 1500), person: flat(t.person, 1500) })) },
    };
    const answer = await this.deps.run(context);
    if (carriesSecret(answer.reply)) return null;
    // A pack-written text keeps an address only when it is exactly the one the machine gave (the card's PR link): a domain-shaped token or any other
    // scheme drops it. A file name stands only when the token is in a docs excerpt the machine itself supplied.
    if (holdsForeignAddress(answer.reply, { given, files: docs.flatMap(domainTokens) })) {
      onRefused?.(ADDRESS_REFUSED);
      return null;
    }
    const text = postableKeeping(answer.reply, given);
    return text === "" ? null : text;
  }
}
