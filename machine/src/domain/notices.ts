// The words the machine says outward at a card's own source about what happened to it.
import { postable } from "./postable.ts";

/** What a card is told when it is archived: a clock's reasons say who did not answer. */
export function archivedNotice(reason: unknown): string {
  if (reason === "no_setup") return "Archived: nobody set the repository up in time.";
  if (reason === "no_answer") return "Archived: nobody answered the questions in time.";
  return `Archived: ${String(reason ?? "no reason given")}.`;
}

/** The questions at `awaiting_answers` as one comment: flattened, each capped, with the suggested answer. */
export function questionsComment(questions: Array<{ question: string; recommended: string | null }>): string {
  const list = questions.map((q, i) => `${i + 1}) ${postable(q.question, 300)}${q.recommended ? ` (suggested: ${postable(q.recommended, 100)})` : ""}`);
  return postable(`Luna needs your answers to go on: ${list.join(" ")}`);
}
