// The questionnaire job (RFC 0008, wave 3). When triage calls a Slack thread or a Jira issue a `compliance_request` and it carries
// a text file (or, in Slack, two or more questions inline), the file is downloaded, the repository's policy, control and answer-bank
// pages are read from its wiki, the `questionnaire` pack answers from them, and one draft waits for the person. One draft per source
// item: the id is the dedupe. Nothing here throws into triage: a failure is a log line and the item is left as it was.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type ComplianceDraft, type ComplianceTarget, QuestionnaireAnswer, type QuestionnaireContext } from "@hardness/contracts";
import { z } from "zod";

import { filledMarkdown } from "../domain/questionnaire.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import { textFileRefusal } from "../domain/text-file.ts";
import { COMPLIANCE_DIR, type ComplianceDrafts, DraftNotFoundError, DraftStatusError } from "./compliance-drafts.ts";
import type { Jira, JiraIssue } from "./jira.ts";
import type { Slack } from "./slack.ts";
import type { Wiki } from "./wiki.ts";

const POLICY_DIRS = ["Compliance/Policies/", "Compliance/Controls/"];
const BANK_DIR = "Compliance/Answers/";
const MAX_POLICIES = 20;
const POLICY_CAP = 12_000;
const MAX_BANK = 100;
const BANK_CAP = 2_000;
const MARKDOWN_CAP = 100_000;

const Source = z.object({
  name: z.string(),
  markdown: z.string(),
  source: z.enum(["slack", "jira"]),
  requester: z.string().nullable(),
  /** The target that takes the filled text back to where the questionnaire came from. */
  reply: z.union([z.object({ kind: z.literal("slack_thread"), channel: z.string(), ts: z.string() }), z.object({ kind: z.literal("jira_comment"), key: z.string() })]),
  /** What names the repository: the item's own text. */
  hint: z.string(),
});
type Source = z.infer<typeof Source>;

export interface QuestionnairesDeps {
  slack: Pick<Slack, "downloadFile">;
  jira: Pick<Jira, "attachments" | "downloadAttachment">;
  wiki: Pick<Wiki, "readPages">;
  drafts: Pick<ComplianceDrafts, "open" | "get">;
  /** One run of the `questionnaire` pack; its answer is validated here. */
  run(context: QuestionnaireContext): Promise<unknown>;
  /** The `owner/name` of every repository the machine knows. */
  repos(): Promise<string[]>;
  /** `MACHINE_MANAGER_WIKI_REPO`, the repository used when the text names none. */
  defaultRepo: string | null;
  stateDir: string;
  log?: (line: string) => void;
}

/** True when the text holds at least two sentences that end in a question mark. */
export const hasInlineQuestions = (text: string): boolean => (text.match(/\?(?=\s|$)/g) ?? []).length >= 2;

/** The known repository the text names, by `owner/name` or by name; else the default; else null. */
export function pickRepo(text: string, known: string[], fallback: string | null): string | null {
  const lower = text.toLowerCase();
  const edge = "[^a-z0-9_.-]";
  for (const slug of known) if (lower.includes(slug.toLowerCase())) return slug;
  for (const slug of known) {
    const name = slug.split("/")[1]!.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|${edge})${name}($|${edge})`).test(lower)) return slug;
  }
  return fallback;
}

export class Questionnaires {
  private readonly log: (line: string) => void;

  constructor(private readonly deps: QuestionnairesDeps) {
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  /** A thread triage marked `compliance_request`: a draft, or null when there is nothing to answer, it has a draft already, or it failed (logged). */
  async fromSlack(row: SlackItemRow): Promise<ComplianceDraft | null> {
    if (row.triage?.category !== "compliance_request") return null;
    const id = `questionnaire:slack:${row.id}`;
    try {
      if (await this.deps.drafts.get(id)) return null;
      const files = (row.conversation?.history ?? []).flatMap((m) => m.attachments);
      let file: { name: string; text: string } | null = null;
      for (const f of files) {
        if (textFileRefusal(f.name, "", null)) continue;
        try {
          file = await this.deps.slack.downloadFile(f.id);
          break;
        } catch (error) {
          this.log(`questionnaires: ${id}: ${f.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!file && !hasInlineQuestions(row.text)) return null;
      const source: Source = {
        name: file?.name ?? "Slack thread",
        markdown: (file?.text ?? row.text).slice(0, MARKDOWN_CAP),
        source: "slack",
        requester: row.author.name,
        reply: { kind: "slack_thread", channel: row.channel.id, ts: row.id.split(":")[1] ?? row.slackTs },
        hint: `${row.text}\n${file?.name ?? ""}\n${file?.text ?? ""}`,
      };
      return await this.build(id, source, null);
    } catch (error) {
      this.log(`questionnaires: ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** An issue triage_signals called `compliance_request`: its first text attachment is the questionnaire. */
  async fromJira(issue: JiraIssue): Promise<ComplianceDraft | null> {
    const id = `questionnaire:jira:${issue.key}`;
    try {
      if (await this.deps.drafts.get(id)) return null;
      const attachment = (await this.deps.jira.attachments(issue.key)).find((a) => textFileRefusal(a.name, a.mimetype, a.size) === null);
      if (!attachment) return null;
      const file = await this.deps.jira.downloadAttachment(attachment.id);
      const source: Source = {
        name: file.name,
        markdown: file.text.slice(0, MARKDOWN_CAP),
        source: "jira",
        requester: issue.reporter?.name ?? null,
        reply: { kind: "jira_comment", key: issue.key },
        hint: `${issue.summary}\n${issue.description}\n${file.text}`,
      };
      return await this.build(id, source, null);
    } catch (error) {
      this.log(`questionnaires: ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The same questionnaire answered from another repository's pages; the draft is reopened there. A posting or posted draft is refused (`DraftStatusError`). */
  async rerun(id: string, repo: string): Promise<ComplianceDraft> {
    const held = await this.deps.drafts.get(id);
    if (!held) throw new DraftNotFoundError(id);
    if (held.status === "posting" || held.status === "posted") throw new DraftStatusError(id, held.status);
    const source = await this.loadSource(id);
    if (!source) throw new DraftNotFoundError(id);
    const draft = await this.build(id, source, repo);
    if (!draft) throw new Error(`no policy pages in the wiki of ${repo}`);
    return draft;
  }

  private async build(id: string, source: Source, forced: string | null): Promise<ComplianceDraft | null> {
    const repo = forced ?? pickRepo(source.hint, await this.deps.repos(), this.deps.defaultRepo);
    if (!repo) {
      this.log(`questionnaires: ${id}: no repository named in the text and no MACHINE_MANAGER_WIKI_REPO, so it was skipped`);
      return null;
    }
    const policies = await this.pages(repo, POLICY_DIRS, MAX_POLICIES, POLICY_CAP);
    if (policies.length === 0) {
      this.log(`questionnaires: ${id}: no policy pages under Compliance/Policies/ or Compliance/Controls/ in the wiki of ${repo}, so it was skipped`);
      return null;
    }
    const bank = await this.pages(repo, [BANK_DIR], MAX_BANK, BANK_CAP);
    const context: QuestionnaireContext = { repo, source: source.source, requester: source.requester, questionnaire: { name: source.name, markdown: source.markdown }, policies, bank };
    const parsed = QuestionnaireAnswer.parse(await this.deps.run(context));
    const known = new Set([...policies, ...bank].map((p) => p.path));
    const bankPaths = new Set(bank.map((p) => p.path));
    const answers = parsed.answers.map((a) => ({ ...a, citations: a.citations.filter((c) => known.has(c)), fromBank: a.fromBank && bankPaths.has(a.fromBank) ? a.fromBank : null }));
    await this.saveSource(id, source);
    const targets: ComplianceTarget[] = [source.reply, { kind: "answer_bank", repo }];
    return this.deps.drafts.open({
      id,
      kind: "questionnaire",
      repo,
      title: `Questionnaire: ${source.name}`,
      period: null,
      summary: `${answers.length} answered, ${parsed.unanswered.length} unanswered`,
      text: filledMarkdown(source.name, answers, parsed.unanswered),
      targets,
    });
  }

  private async pages(repo: string, prefixes: string[], max: number, cap: number): Promise<Array<{ path: string; text: string }>> {
    const out: Array<{ path: string; text: string }> = [];
    for (const prefix of prefixes) for (const p of await this.deps.wiki.readPages(repo, prefix)) out.push({ path: p.path, text: p.text.slice(0, cap) });
    return out.slice(0, max);
  }

  private fileOf(id: string): string {
    return join(this.deps.stateDir, COMPLIANCE_DIR, "questionnaires", `${createHash("sha256").update(id).digest("hex").slice(0, 24)}.json`);
  }

  /** The questionnaire is kept beside its draft so a re-run against another repository has it. */
  private async saveSource(id: string, source: Source): Promise<void> {
    const path = this.fileOf(id);
    await mkdir(join(this.deps.stateDir, COMPLIANCE_DIR, "questionnaires"), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(source));
    await rename(`${path}.tmp`, path);
  }

  private async loadSource(id: string): Promise<Source | null> {
    try {
      return Source.parse(JSON.parse(await readFile(this.fileOf(id), "utf8")));
    } catch {
      return null;
    }
  }
}
