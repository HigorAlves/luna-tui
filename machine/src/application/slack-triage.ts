// The triage port: a batch of inbox items in, one verdict per item out. The slack_triage pack
// (application/stages/slack-triage-runner.ts) runs it in the stage container; tests pass a
// fake; with agents off, no credential or no image the inbox runs with no triager at all and
// items show `triage: null`.
import type { SlackTriage, SlackWatch } from "@hardness/contracts";

/** One item as the model sees it. */
export interface TriageItem {
  id: string;
  channel: string;
  author: string;
  text: string;
  /** Earlier messages of the thread, oldest first, as `@name: text`. */
  context: string[];
  /** Why it is in the inbox: `me`, `usergroup:S…`, `broadcast:here`, `keyword:…`, `channel:C…`, `dm`. */
  matched: string[];
  isBot: boolean;
  /** Replies in the thread since the item's first message. */
  threadReplies: number;
}

export interface TriageContext {
  /** Who the inbox belongs to; the model triages for this person. */
  me: { id: string; name: string };
  /** The rules file's Notes section. */
  notes: string;
  /** The Learned lines, as written. */
  learned: string[];
  /** The VIPs section, as written: each is at least P1. */
  vips: string[];
  watches: SlackWatch[];
}

/** The model's part of a triage; the inbox adds `by`, `triagedAt` and `overridden`. */
export type TriageAnswer = Omit<SlackTriage, "by" | "triagedAt" | "overridden">;

export interface Triager {
  /**
   * Verdicts by item id; an item the model skipped is simply absent. A run that produced no
   * result at all (no container, a timeout, an unreadable answer) rejects, with a
   * `TriageRunError` when earlier batches of the same call already have verdicts.
   */
  triage(items: TriageItem[], context: TriageContext): Promise<Map<string, TriageAnswer>>;
}

/** A batch failed to run (the Datadog runner uses it too, with its own verdict type); `answers` holds what the batches before it settled. */
export class TriageRunError<A = TriageAnswer> extends Error {
  constructor(
    message: string,
    readonly answers: Map<string, A>,
  ) {
    super(message);
    this.name = "TriageRunError";
  }
}

/** The most items one call carries. */
export const TRIAGE_BATCH = 25;
