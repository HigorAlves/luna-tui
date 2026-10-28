// The triage port: a batch of inbox items in, one verdict per item out. The Anthropic adapter
// asks Haiku; tests pass a fake; without an API key the inbox runs with no triager at all and
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
}

export interface TriageContext {
  /** The rules file's Notes section. */
  notes: string;
  /** The Learned lines, as written. */
  learned: string[];
  watches: SlackWatch[];
}

/** The model's part of a triage; the inbox adds `by`, `triagedAt` and `overridden`. */
export type TriageAnswer = Omit<SlackTriage, "by" | "triagedAt" | "overridden">;

export interface Triager {
  /** Verdicts by item id; an item the model skipped is simply absent. */
  triage(items: TriageItem[], context: TriageContext): Promise<Map<string, TriageAnswer>>;
}

/** The most items one call carries. */
export const TRIAGE_BATCH = 25;
