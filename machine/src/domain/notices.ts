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

interface CardView {
  repoPath: string | null;
  /** The card's sources, in the machine's shape (`kind`) or the diagram's (`type`). */
  sources: ReadonlyArray<object>;
}

interface Src {
  kind?: string;
  repo?: string;
  channel?: string;
  key?: string;
}
const srcs = (card: CardView): Src[] => card.sources as Src[];
const githubRepos = (card: CardView): string[] => srcs(card).filter((s) => s.kind === "github" || s.kind === "github_pr").map((s) => String(s.repo));
const projectOf = (key: string | undefined): string | null => /^([A-Z][A-Z0-9_]+)-\d+$/.exec(key ?? "")?.[1] ?? null;

/** Whether the reporter of `dup` could already see the card it is merged into: the same repository and, for a private Slack or Jira source, the same channel or project. */
export function canSeeKept(dup: CardView, kept: CardView): boolean {
  const sameRepo = (dup.repoPath !== null && dup.repoPath === kept.repoPath) || githubRepos(dup).some((r) => githubRepos(kept).includes(r));
  if (!sameRepo) return false;
  const first = srcs(kept)[0];
  if (first?.kind === "slack") return srcs(dup).some((s) => s.kind === "slack" && s.channel === first.channel);
  if (first?.kind === "jira") return srcs(dup).some((s) => s.kind === "jira" && projectOf(s.key) !== null && projectOf(s.key) === projectOf(first.key));
  return true;
}

/** What a duplicate's source is told: which card tracks it (fixed words, the card's id and a link, never its title or text) when its reporter could see that card, else only that the report is tracked. */
export function mergedNotice(keptId: string | null, link: string | null): string {
  if (!keptId) return postable("This report is already tracked on another card.", 200);
  return postable(`This report was merged into card ${keptId.slice(0, 8)}${link ? `: ${link}` : ""}. Follow it there.`, 400);
}
