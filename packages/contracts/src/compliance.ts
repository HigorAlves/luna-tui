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
export const ChangeExceptionKind = z.enum(["no_independent_approval", "stale_approval", "no_ticket", "checks_red", "checks_not_green", "bypassed"]);
export type ChangeExceptionKind = z.infer<typeof ChangeExceptionKind>;

/** The body of an approve or an ignore tap. */
export const ComplianceActInput = z.object({ hash: z.string().regex(/^[0-9a-f]{16}$/) });
export type ComplianceActInput = z.infer<typeof ComplianceActInput>;

/** `POST /compliance/drafts/:id/repo`: the repository whose wiki a questionnaire is answered from. */
export const ComplianceRepoInput = z.object({ repo: Slug });
export type ComplianceRepoInput = z.infer<typeof ComplianceRepoInput>;

export const ComplianceReposResponse = z.object({ repos: z.array(Slug) });
export type ComplianceReposResponse = z.infer<typeof ComplianceReposResponse>;

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

/** postmortem: a blameless page written from an incident's facts. The facts, the breach clocks and the timeline are the machine's; this is the reading and the follow-up. */
export const PostmortemAnswer = z.object({
  summary: z.string().min(1).max(800),
  impact: z.string().min(1).max(800),
  timeline: z.array(z.object({ at: z.string().min(1), text: z.string().min(1).max(300) })).max(40),
  rootCauses: z.array(z.string().min(1).max(400)).max(5),
  contributingFactors: z.array(z.string().min(1).max(400)).max(10),
  actionItems: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        owner: z.string().max(120).nullable(),
        /** `YYYY-MM-DD`. */
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable(),
      }),
    )
    .max(10),
  /** Each notification deadline and who must be told, when the breach assessment found regimes; no legal conclusions. */
  breachNotes: z.string().max(1500).nullable(),
});
export type PostmortemAnswer = z.infer<typeof PostmortemAnswer>;

/** questionnaire: each question answered from the policy, control and answer-bank pages it was given, or named as unanswered with why. Citations are page paths from the context. */
export const QuestionnaireAnswer = z.object({
  answers: z.array(
    z.object({
      n: z.number().int().min(1),
      question: z.string().min(1).max(2000),
      answer: z.string().min(1).max(1500),
      /** Paths of the wiki pages the answer rests on. */
      citations: z.array(z.string().min(1).max(300)).max(10),
      /** The answer-bank page the answer was taken from, when one fit. */
      fromBank: z.string().min(1).max(300).nullable(),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ).max(300),
  unanswered: z.array(z.object({ n: z.number().int().min(1), question: z.string().min(1).max(2000), why: z.string().min(1).max(400) })).max(300),
});
export type QuestionnaireAnswer = z.infer<typeof QuestionnaireAnswer>;

/** release_notes: the user-facing notes of one release, from the merged PRs. Each item names the PRs it covers; the machine drops a number it did not give. */
export const ReleaseNotesAnswer = z.object({
  highlights: z.array(z.string().min(1).max(200)).max(5),
  sections: z.array(
    z.object({
      heading: z.enum(["Features", "Fixes", "Security", "Other"]),
      items: z.array(z.object({ text: z.string().min(1).max(200), prs: z.array(z.number().int().min(1)).max(20) })).max(50),
    }),
  ),
  /** Each breaking change, in plain words. */
  breaking: z.array(z.string().min(1).max(300)).max(10),
});
export type ReleaseNotesAnswer = z.infer<typeof ReleaseNotesAnswer>;

/** status_report: the engineering manager's weekly status for leadership. The machine's facts are the record; this is how they read. `summary` is the Slack text. */
export const StatusReportAnswer = z.object({
  headline: z.string().min(1).max(200),
  shipped: z.array(z.string().min(1).max(300)).max(8),
  risks: z.array(z.string().min(1).max(300)).max(6),
  compliance: z.array(z.string().min(1).max(300)).max(6),
  /** Decisions needed from leadership. */
  asks: z.array(z.string().min(1).max(300)).max(4),
  summary: z.string().min(1).max(600),
});
export type StatusReportAnswer = z.infer<typeof StatusReportAnswer>;

/** vuln_triage: one security alert turned into a work item. `fast` is a patch or minor bump with a patched version, `hold` waits for the person, `full` is every other card. */
export const VulnLane = z.enum(["fast", "full", "hold"]);
export type VulnLane = z.infer<typeof VulnLane>;

export const VulnTriageAnswer = z.object({
  lane: VulnLane,
  /** YYYY-MM-DD: from the company's policy when it gave one, else the defaults of the role. */
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(600),
  acceptance_criteria: z.array(z.string().min(1).max(300)).min(1).max(5),
  reason: z.string().min(1).max(300),
});
export type VulnTriageAnswer = z.infer<typeof VulnTriageAnswer>;
