// The context-complete check: a fact, so a script. A card that lacks a repository, a reporter that can be reached or enough to act on waits at Intake.
export const CONTEXT_MIN_WORDS = 20;

export type ContextMissing = "repository" | "reporter" | "text";

export interface ContextCard {
  repoPath: string | null;
  title: string;
  description: string;
  /** Null when nobody reported it; a reporter with no channel cannot be asked. */
  reporter: { id: string; channel?: string | null } | null;
  attachments: number;
}

export function contextComplete(card: ContextCard): { complete: boolean; missing: ContextMissing[] } {
  const missing: ContextMissing[] = [];
  if (!card.repoPath) missing.push("repository");
  if (card.reporter && !card.reporter.channel) missing.push("reporter");
  const words = `${card.title} ${card.description}`.split(/\s+/).filter(Boolean).length;
  if (words < CONTEXT_MIN_WORDS && card.attachments === 0) missing.push("text");
  return { complete: missing.length === 0, missing };
}
