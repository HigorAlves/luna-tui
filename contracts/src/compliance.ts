// The manager's drafts (RFC 0008): every page, post, comment, issue and release body an agent
// writes for the person waits here until the person approves, edits or ignores it in the board's
// Compliance view. The machine computes the hash of the shown text; a tap must name it, so a
// draft that changed under the person never posts.
import { z } from "zod";

/** A regime a repo answers to (luna.yaml `compliance:`); the compliance review runs one reviewer for each. */
export const ComplianceRegime = z.enum(["soc2", "hipaa", "gdpr", "lgpd", "us_privacy"]);
export type ComplianceRegime = z.infer<typeof ComplianceRegime>;

/** What a draft is: wave 1's change evidence, wave 3's questionnaire answers, wave 4's access review, wave 5's postmortem,
 *  wave 7's status report and wave 6's release notes. */
export const ComplianceDraftKind = z.enum(["change_evidence", "questionnaire", "access_review", "postmortem", "status_report", "release_notes"]);
export type ComplianceDraftKind = z.infer<typeof ComplianceDraftKind>;

/** `waiting` for a tap; `edited` is still waiting, with the person's text; `ignored` is kept and never posted; `posting` is claimed by an approve. */
export const ComplianceDraftStatus = z.enum(["waiting", "edited", "ignored", "posting", "posted"]);
export type ComplianceDraftStatus = z.infer<typeof ComplianceDraftStatus>;

const Slug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name");
/** A page path inside a wiki: relative, no `..` segment, ends in `.md`. */
const WikiPath = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\/-]*\.md$/, "a relative .md path")
  .refine((path) => !path.split("/").includes(".."), "no .. segment");

const SlackChannel = z.string().regex(/^[CDG][A-Z0-9]{2,}$/, "a Slack channel id");
const JiraProject = z.string().regex(/^[A-Z][A-Z0-9_]+$/, "a Jira project key");

/** Where an approved draft goes. The publisher has one writer per kind:
 *  - `wiki`: the draft's text as one page of a repo's wiki.
 *  - `slack_thread` / `slack_channel`: the text as a reply in a thread, or a post in a channel.
 *  - `jira_comment`: the text as a comment on an issue.
 *  - `jira_actions`: the text's action items, each filed as an issue in a project.
 *  - `answer_bank`: each question and answer of an approved questionnaire, as a page under `Compliance/Answers/` in a repo's wiki.
 *  - `access_slices`: each repo's part of an org's signed access review, as a page in that repo's wiki.
 *  - `github_release`: the text as the body of a repo's release. */
export const ComplianceTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("wiki"), repo: Slug, path: WikiPath }),
  z.object({ kind: z.literal("slack_thread"), channel: SlackChannel, ts: z.string().regex(/^\d+\.\d+$/, "a Slack message ts") }),
  z.object({ kind: z.literal("slack_channel"), channel: SlackChannel }),
  z.object({ kind: z.literal("jira_comment"), key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, "a Jira issue key") }),
  z.object({ kind: z.literal("jira_actions"), project: JiraProject }),
  z.object({ kind: z.literal("answer_bank"), repo: Slug }),
  z.object({ kind: z.literal("access_slices"), org: z.string().regex(/^[A-Za-z0-9-]+$/, "a GitHub org"), period: z.string().regex(/^\d{4}-Q[1-4]$/, "a quarter, 2026-Q4") }),
  z.object({ kind: z.literal("github_release"), repo: Slug, tag: z.string().regex(/^[A-Za-z0-9._\/-]+$/, "a tag") }),
]);
export type ComplianceTarget = z.infer<typeof ComplianceTarget>;

export const ComplianceDraft = z.object({
  /** Stable per kind, repo and period, so a re-run updates the draft instead of opening a second. */
  id: z.string().min(1),
  kind: ComplianceDraftKind,
  repo: Slug,
  title: z.string().min(1),
  /** The period a periodic draft covers (`2026-10`, `2026-Q4`, `2026-W46`); null for one that has none. */
  period: z.string().nullable(),
  /** One line for the list. */
  summary: z.string(),
  /** The markdown the person reads and the targets receive. */
  text: z.string(),
  /** The machine's own text, kept beside an edit. */
  original: z.string().optional(),
  status: ComplianceDraftStatus,
  /** The first 16 hex digits of the sha256 of `text`: what a tap must name. */
  hash: z.string().regex(/^[0-9a-f]{16}$/),
  targets: z.array(ComplianceTarget).min(1),
  history: z.array(z.object({ at: z.string(), did: z.enum(["edited", "ignored", "posted", "failed"]), from: z.string() })),
  /** Why the last approve did not post, in the target's own words. */
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ComplianceDraft = z.infer<typeof ComplianceDraft>;

export const ComplianceDraftsResponse = z.object({ drafts: z.array(ComplianceDraft) });
export type ComplianceDraftsResponse = z.infer<typeof ComplianceDraftsResponse>;

/** Why a merged PR fails change management (SOC2 CC8.1): no approval by a person other than its author;
 *  approvals only on an earlier commit than the one merged; no Jira key or closing issue; a check that
 *  failed at the merged commit; a ruleset bypassed at the merge. */
export const ChangeExceptionKind = z.enum(["no_independent_approval", "stale_approval", "no_ticket", "checks_red", "bypassed"]);
export type ChangeExceptionKind = z.infer<typeof ChangeExceptionKind>;

/** The body of an approve or an ignore tap. */
export const ComplianceActInput = z.object({ hash: z.string().regex(/^[0-9a-f]{16}$/) });
export type ComplianceActInput = z.infer<typeof ComplianceActInput>;

/** The body of an edit tap. */
export const ComplianceEditInput = ComplianceActInput.extend({ text: z.string().min(1) });
export type ComplianceEditInput = z.infer<typeof ComplianceEditInput>;

/** change_exceptions: one short explanation per (PR, kind) the machine found. The machine's facts are the record; this is only the reading of the PR's own words. */
export const ChangeExceptionsAnswer = z.object({
  explanations: z.array(
    z.object({
      pr: z.number().int().min(1),
      kind: ChangeExceptionKind,
      text: z.string().min(1).max(400),
      /** Who should confirm, or what is missing, when the PR's text explains nothing. */
      followUp: z.string().max(200).nullable(),
    }),
  ),
});
export type ChangeExceptionsAnswer = z.infer<typeof ChangeExceptionsAnswer>;

/** access_review: one suggestion per flag of a quarter's access review. The person decides; nothing here removes access. */
export const AccessReviewAnswer = z.object({
  recommendations: z.array(
    z.object({
      flagId: z.string().min(1).max(300),
      action: z.enum(["keep", "remove", "reduce", "investigate"]),
      reason: z.string().min(1).max(300),
    }),
  ),
  summary: z.string().max(600),
});
export type AccessReviewAnswer = z.infer<typeof AccessReviewAnswer>;
