// The words the machine says outward at a card's own source about what happened to it.
import { createHash } from "node:crypto";

import { carriesSecret, postable } from "./postable.ts";

/** What a card is told when it is archived: a clock's reasons say who did not answer. */
export function archivedNotice(reason: unknown): string {
  if (reason === "no_setup") return "Archived: nobody set the repository up in time.";
  if (reason === "split") return "This was split into smaller changes; each one ships on its own.";
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

/** Whether the reporter of `dup` could already see the card it is (or would be) merged into. It fails closed, by the kept card's own first source:
 *  a GitHub card is seen by a report from that GitHub repository, a Slack card by one from the same channel, a Jira card by one from the same project.
 *  A card with no source, one in the diagram's shape (`type`: its audience is unknown) or from anywhere else is seen by nobody. Both cards' sources are read in the machine's shape (`kind`). */
export function canSeeKept(dup: CardView, kept: CardView): boolean {
  const first = srcs(kept)[0];
  if (!first || typeof first.kind !== "string") return false;
  if (first.kind === "github" || first.kind === "github_pr") return typeof first.repo === "string" && githubRepos(dup).includes(first.repo);
  if (first.kind === "slack") return typeof first.channel === "string" && srcs(dup).some((s) => s.kind === "slack" && s.channel === first.channel);
  if (first.kind === "jira") {
    const project = projectOf(first.key);
    return project !== null && srcs(dup).some((s) => s.kind === "jira" && projectOf(s.key) === project);
  }
  return false;
}

/** What a duplicate's source is told: which card tracks it (fixed words, the card's id and a link, never its title or text) when its reporter could see that card, else only that the report is tracked. */
export function mergedNotice(keptId: string | null, link: string | null): string {
  if (!keptId) return postable("This report is already tracked on another card.", 200);
  // The link is the machine's own (its public board address and the card's id), so it is printed outside `postable`, which breaks every address; one that is not a plain web address is left out.
  const own = link !== null && /^https?:\/\/[^\s<>"'`\u0000-\u001f]{1,500}$/i.test(link) ? link : null;
  return `${postable(`This report was merged into card ${keptId.slice(0, 8)}`, 200)}${own ? `: ${own}` : ""}. Follow it there.`;
}
