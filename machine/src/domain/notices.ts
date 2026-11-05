// The words the machine says outward at a card's own source about what happened to it.
import { createHash } from "node:crypto";

import { carriesSecret, postable } from "./postable.ts";

/** What a card is told when it is archived: a clock's reasons say who did not answer. */
export function archivedNotice(reason: unknown): string {
  if (reason === "no_setup") return "Archived: nobody set the repository up in time.";
  if (reason === "no_answer") return "Archived: nobody answered the questions in time.";
  return `Archived: ${String(reason ?? "no reason given")}.`;
}

/** The questions at `awaiting_answers` as one comment: flattened, each capped, with the suggested answer. `secret` is read from the raw text,
 *  before flattening redacts it: a question that held a token-shaped string is refused at every sink, not posted with `[redacted]`. */
export function questionsComment(questions: Array<{ question: string; recommended: string | null }>): { body: string; secret: boolean; hash: string } {
  const list = questions.map((q, i) => `${i + 1}) ${postable(q.question, 300)}${q.recommended ? ` (suggested: ${postable(q.recommended, 100)})` : ""}`);
  const secret = questions.some((q) => carriesSecret(q.question) || (q.recommended !== null && carriesSecret(q.recommended)));
  const hash = createHash("sha256").update(JSON.stringify(questions.map((q) => [q.question, q.recommended]))).digest("hex").slice(0, 16);
  return { body: postable(`Luna needs your answers to go on: ${list.join(" ")}`), secret, hash };
}
