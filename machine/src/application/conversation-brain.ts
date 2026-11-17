// What the company brain holds about a thread, for the reply draft (RFC 0010): the rows `brainEvidence` reads for the thread's latest message, only
// for a conversation that belongs to a repository whose `luna.yaml` has `brain.tell: "on"`. Anything else, and any failure, is no rows: the draft never waits on the brain.
import type { BrainAskRow } from "@hardness/contracts";

import type { Brain } from "./brain.ts";
import { brainEvidence } from "./brain-ask.ts";

export const MAX_BRAIN_ROWS = 12;
const MAX_QUESTION = 2000;

export interface ConversationBrainDeps {
  brain: Brain;
  /** The repository's `brain.tell` is `on`. */
  tells(repo: string): Promise<boolean>;
}

export function conversationBrain(deps: ConversationBrainDeps): (text: string, repo: string | null) => Promise<BrainAskRow[]> {
  return async (text, repo) => {
    if (!repo || !deps.brain.enabled) return [];
    try {
      if (!(await deps.tells(repo))) return [];
      return (await brainEvidence(deps.brain, text.slice(0, MAX_QUESTION))).slice(0, MAX_BRAIN_ROWS);
    } catch {
      return [];
    }
  };
}
