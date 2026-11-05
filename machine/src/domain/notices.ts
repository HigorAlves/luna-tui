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

const MISSING_WORDS = { repository: "which repository it is for", reporter: "a way to reach you", text: "more detail on what is wrong" } as const;

/** What the reporter is asked at a card's source when Intake cannot start it: fixed words built from what is missing, never the card's own text. */
export function contextAsk(missing: Array<keyof typeof MISSING_WORDS>): { body: string; secret: false; hash: string } {
  const list = missing.map((m) => MISSING_WORDS[m]).join(", ");
  const body = postable(`Luna needs a little more to start this card: ${list}. Reply here with them.`);
  return { body, secret: false, hash: createHash("sha256").update(missing.join(",")).digest("hex").slice(0, 16) };
}

/** What a duplicate's source is told: which card tracks it. Fixed words, the kept card's id and a link, never its title or text. */
export function mergedNotice(keptId: string, link: string | null): string {
  return postable(`This report was merged into card ${keptId.slice(0, 8)}${link ? `: ${link}` : ""}. Follow it there.`, 400);
}
