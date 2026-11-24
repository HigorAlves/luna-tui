// What a thread's relation does once it is not `ask`: attach to a card, raise a backlog item's demand, join the backlog, or nothing.
// None of the four posts to Slack or makes a card: a card from a conversation is made only by a person's tap (`SlackInbox.toTask`).
// Each runs once per thread: the relation carries an `applied` stamp that a second run reads.
import type { BacklogAddInput, ConversationRelation, SlackPriority } from "@hardness/contracts";

import { candidateOf } from "../domain/conversation-candidate.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";

export interface ThreadRef {
  channel: string;
  /** The thread's root ts. */
  ts: string;
  permalink: string;
  authorId: string;
}

export interface ActionDeps {
  /** `Pipeline.attachThread`: the thread into the card's links, its author into the followers; answers the card's priority when it has one. */
  attachThread(cardId: string, thread: ThreadRef): Promise<{ priority: SlackPriority | null }>;
  bump(backlogId: string): Promise<void>;
  unbump(backlogId: string): Promise<void>;
  /** `Backlog.upsertFromSource(input, { createIfMissing: true })`. */
  addCandidate(input: BacklogAddInput): Promise<{ id: string }>;
  /** `SlackStore.itemsLinkedTo`: the items whose relation points at the backlog item. */
  linkedTo(backlogId: string): Promise<SlackItemRow[]>;
}

export interface Applied {
  relation: ConversationRelation;
  /** The card the item now belongs to, for `linked.taskId`. */
  taskId?: string;
  /** The card's priority, which the item takes. */
  priority?: SlackPriority;
}

export class ConversationActions {
  constructor(
    private readonly deps: ActionDeps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async apply(row: SlackItemRow, relation: ConversationRelation): Promise<Applied> {
    if (relation.type === "ask" || relation.applied) return { relation };
    const at = this.now().toISOString();
    const root = row.id.split(":")[1] ?? row.slackTs;
    if (relation.type === "related_to_in_progress" && relation.target) {
      const card = await this.deps.attachThread(relation.target, { channel: row.channel.id, ts: root, permalink: row.permalink, authorId: row.author.id });
      return { relation: { ...relation, applied: { at, bumped: false } }, taskId: relation.target, ...(card.priority ? { priority: card.priority } : {}) };
    }
    if (relation.type === "related_to_backlog" && relation.target) {
      const already = (await this.deps.linkedTo(relation.target)).some((other) => other.id !== row.id && other.author.id === row.author.id && other.conversation?.relation?.applied);
      if (!already) await this.deps.bump(relation.target);
      return { relation: { ...relation, applied: { at, bumped: !already } } };
    }
    if (relation.type === "new_candidate") {
      const conversation = row.conversation;
      const scores = conversation?.classification?.scores;
      // Only a public channel one repository claims; anything else is shown as a new candidate and a tap decides.
      if (!conversation || conversation.private || !conversation.repo || !scores) return { relation: { ...relation, applied: { at, bumped: false } } };
      const { title, text } = candidateOf(row);
      const added = await this.deps.addCandidate({
        title,
        text,
        sources: [{ kind: "slack", channel: row.channel.id, ts: root, permalink: row.permalink }],
        repo: conversation.repo,
        scores: { who: scores.who!.score, what: scores.what!.score, impact: scores.impact!.score, time: scores.time!.score, demand: scores.demand!.score },
        size: "M",
        dependsOn: [],
      });
      return { relation: { ...relation, applied: { at, bumped: false, backlog: added.id } } };
    }
    return { relation: { ...relation, applied: { at, bumped: false } } };
  }

  /** A person moved the thread away from a backlog item the machine raised: the bump is taken back. */
  async undo(previous: ConversationRelation | null | undefined, next: ConversationRelation): Promise<void> {
    if (!previous?.applied?.bumped || previous.type !== "related_to_backlog" || !previous.target) return;
    if (next.type === "related_to_backlog" && next.target === previous.target) return;
    await this.deps.unbump(previous.target);
  }
}
