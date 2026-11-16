// The writers of a questionnaire draft's targets (RFC 0008, wave 3): the filled text back to the Slack thread or the Jira
// issue, and each approved answer to the wiki's answer bank. The person's approve is the tap: a Slack post goes through the
// `SlackSender` with it. A post is made once per text: a mark kept under the state dir records each chunk that went out,
// so an approve that failed on a later target posts nothing twice when it is tried again.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { bankPage, chunkText, parseFilled } from "../domain/questionnaire.ts";
import { summaryOf, wikiPageUrl } from "../domain/status-report.ts";
import { COMPLIANCE_DIR, type TargetWriters, commitMessage } from "./compliance-drafts.ts";
import type { Jira } from "./jira.ts";
import type { SlackSender } from "./slack-send.ts";
import type { Wiki } from "./wiki.ts";

/** Under Slack's 4,000-character comfort line for one message. */
export const SLACK_CHUNK = 3_500;
/** Well under Jira's 32,767-character comment. */
export const JIRA_CHUNK = 30_000;

export interface QuestionnaireWriterDeps {
  wiki: Wiki;
  sender: SlackSender;
  jira: Pick<Jira, "comment">;
  stateDir: string;
  now?: () => Date;
  slackLimit?: number;
  jiraLimit?: number;
}

export function questionnaireWriters(deps: QuestionnaireWriterDeps): Pick<TargetWriters, "answer_bank" | "slack_thread" | "slack_channel" | "jira_comment"> {
  const now = deps.now ?? (() => new Date());
  const dir = join(deps.stateDir, COMPLIANCE_DIR, "posted");
  const keyOf = (parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  const done = (key: string) => access(join(dir, key)).then(() => true, () => false);
  const mark = async (key: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, key), "");
  };
  /** Sends each chunk once: a chunk with a mark is skipped, and a mark is written as soon as its chunk is out. */
  async function sendOnce(where: string[], text: string, limit: number, send: (chunk: string) => Promise<unknown>): Promise<void> {
    const chunks = chunkText(text, limit);
    for (const [i, chunk] of chunks.entries()) {
      const key = keyOf([...where, String(i), String(chunks.length), chunk]);
      if (await done(key)) continue;
      await send(chunk);
      await mark(key);
    }
  }

  return {
    async answer_bank(draft, target) {
      const approvedAt = now().toISOString();
      const pages = parseFilled(draft.text).map((a) => bankPage(a.question, a.answer, a.sources, approvedAt, draft.title));
      if (pages.length === 0) return;
      await deps.wiki.writePages(target.repo, pages, commitMessage(draft));
    },

    async slack_thread(draft, target, tap) {
      if (!tap) throw new Error("a Slack post needs a person's tap");
      await sendOnce(["slack", draft.id, target.channel, target.ts], draft.text, deps.slackLimit ?? SLACK_CHUNK, (chunk) => deps.sender.postMessage(tap, target.channel, chunk, target.ts));
    },

    /** The status report's post: the page's `## Summary` and, when the draft also goes to a wiki page, the link to it. One message, under the limit; the link is never cut. */
    async slack_channel(draft, target, tap) {
      if (!tap) throw new Error("a Slack post needs a person's tap");
      const limit = deps.slackLimit ?? SLACK_CHUNK;
      const wiki = draft.targets.find((t) => t.kind === "wiki");
      const link = wiki ? `\n\nFull report: ${wikiPageUrl(wiki.repo, wiki.path)}` : "";
      const text = `${summaryOf(draft.text).slice(0, Math.max(0, limit - link.length)).trimEnd()}${link}`;
      await sendOnce(["slack", draft.id, target.channel], text, limit, (chunk) => deps.sender.postMessage(tap, target.channel, chunk));
    },

    async jira_comment(draft, target) {
      await sendOnce(["jira", draft.id, target.key], draft.text, deps.jiraLimit ?? JIRA_CHUNK, (chunk) => deps.jira.comment(target.key, chunk));
    },
  };
}
