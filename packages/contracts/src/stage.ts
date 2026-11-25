// The stage contract between the machine and the factory runner: the machine writes
// `/in/stage.json` (StageInput) and reads `/out/result.json` (StageOutput). Both sides of
// the seam live in this repository; `factory-contract.test.ts` holds them together.
import { z } from "zod";

import { ChangeExceptionKind, ComplianceRegime } from "./compliance.ts";
import { A11yContext } from "./a11y.ts";
import { CapturePlan, ParityCapture } from "./design-parity.ts";
import { DesignContext } from "./design.ts";
import { DesignSpec } from "./design-spec.ts";
import { EconomyInput, ProposeContext } from "./economy.ts";
import { EngineBudgets, EngineId } from "./engines.ts";
import { EffortId } from "./models.ts";
import { DesignConfig, EvidenceConfigV22, FactoryConfigInput, SecretNameSchema } from "./config-v22.ts";
import { BridgedTool } from "./mcp.ts";
import { Scenario } from "./plan.ts";
import { SizeContext, SplitContext } from "./split.ts";
import { ConfidencePolicySchema } from "./questions.ts";
import { TicketChatTurn, TicketDraft } from "./ticket-chat.ts";

/** What a stage run decided. Lives here, not in api.ts, so the two files do not import each other in a loop. */
export const StageOutcome = z.enum(["pass", "fail", "needs_input", "test_change", "escalated"]);
export type StageOutcome = z.infer<typeof StageOutcome>;

/** Where a task came from: a tracker issue, or an open PR acted on from the PR inbox. */
export const TaskSource = z.discriminatedUnion("kind", [
  /** `labels` are the issue's own at intake: the card keeps them so a `security` label still knocks the priority out to P0 when triage reads the signals again. */
  z.object({ kind: z.literal("github"), repo: z.string(), number: z.number().int(), url: z.string(), labels: z.array(z.string()).optional(), authorAssociation: z.string().optional() }),
  /** A Dependabot or code-scanning alert a vulnerability card stands for. `alert` is the alert's own number, a count apart from issues and PRs: nothing reads it as `#N`. `labels` carry `security` for a critical one, as an issue's do. */
  z.object({ kind: z.literal("github_alert"), repo: z.string(), alert: z.number().int(), tool: z.enum(["dependabot", "code_scanning"]), url: z.string(), labels: z.array(z.string()).optional() }),
  /** The breach-notification card of an incident (`id` is the incident's own id). `labels` carry `security`, as an issue's do, so triage reads the card as P0. */
  z.object({ kind: z.literal("incident"), id: z.string(), labels: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal("github_pr"),
    repo: z.string(),
    number: z.number().int(),
    url: z.string(),
    headRef: z.string(),
    baseRef: z.string(),
    /** GitHub's `author_association` of whoever opened it, at intake (optional: a row from before it parses; none counts as untrusted, `trustOf`). */
    authorAssociation: z.string().optional(),
  }),
  /** A ticket made from a Slack message (`t` in the board's Slack inbox). */
  z.object({ kind: z.literal("slack"), channel: z.string(), ts: z.string(), permalink: z.string() }),
  /** A ticket imported from a Jira issue by intake. `issueType` is Jira's type name, e.g. `Bug`. */
  z.object({ kind: z.literal("jira"), key: z.string(), url: z.string(), issueType: z.string().nullable(), labels: z.array(z.string()).optional() }),
  /** A Luna Notch ticket run on the machine: `ref` is its board key (`LUNA-14`), `id` its uuid.
   *  The notch talks to Jira, Slack and Teams about it; `jiraKey` only names the branch. */
  z.object({ kind: z.literal("notch"), ref: z.string().min(1), id: z.string().min(1), jiraKey: z.string().nullable().optional() }),
]);
export type TaskSource = z.infer<typeof TaskSource>;

/** Which graph a task walks: `feature` is the full pipeline; `config` is a luna.yaml change that waits at the setup gate and runs no stage; the others are PR tasks. */
export const TaskRoute = z.enum(["feature", "setup", "config", "ci_fix", "review", "address"]);
export type TaskRoute = z.infer<typeof TaskRoute>;

/** A question the stage could not answer alone, with the answer it would pick. */
export const NeedsInputItem = z.object({
  question: z.string(),
  /** Null when the stage has no default to offer. */
  recommended: z.string().nullable(),
});
export type NeedsInputItem = z.infer<typeof NeedsInputItem>;

/** A hard-outward action the stage refused to run inside the sandbox; the board approves it. */
export const RequestedAction = z.object({
  kind: z.enum(["tracker_write", "pr_review_post", "publish"]),
  target: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type RequestedAction = z.infer<typeof RequestedAction>;

export const ArtifactKind = z.enum([
  "qa-manifest",
  "screenshot",
  "video",
  "har",
  "report",
  "test",
  "diff",
  "findings",
  "rules",
  // A video's narration and its caption files (.srt, .vtt).
  "audio",
  "captions",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** A file a stage produced; `path` is relative to `/out`. */
export const StageArtifact = z.object({
  kind: ArtifactKind,
  path: z.string(),
  label: z.string(),
  sha256: z.string(),
});
export type StageArtifact = z.infer<typeof StageArtifact>;

/** One review finding, as in the review-contract skill. */
export const Finding = z.object({
  path: z.string(),
  line: z.number().int(),
  // The pack answers require path/line/severity/title/body/confidence only; the rest is
  // optional there, so it must be optional here or every run with a finding fails to ingest.
  start_line: z.number().int().nullable().optional(),
  side: z.string().optional(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  suggestion_code: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  // v2.2, all optional: a finding written before the wave has none of them (see finding.ts).
  id: z.string().optional(),
  category: z.enum(["correctness", "missing_criterion", "security", "error_handling", "convention", "performance", "env", "tests", "size", "accessibility", "design"]).optional(),
  criterion_ref: z.string().nullable().optional(),
  suggested_fix: z.string().nullable().optional(),
  description: z.string().optional(),
  /** How the finding ended: fixed in a commit, kept by the author, or dismissed by a person. */
  resolution: z.object({ status: z.enum(["fixed", "kept", "dismissed", "waived"]), by: z.string(), commit: z.string().optional(), /** True when the machine worked the resolution out (a finding that stopped being raised), rather than a person or a stage saying so. */ inferred: z.boolean().optional() }).optional(),
  /** A design finding (RFC 0013): where in the frame and where in the build. */
  design: z.object({ source: z.enum(["parity", "a11y"]), frame: z.string().optional(), node: z.string().optional(), element: z.string(), viewport: z.string().optional(), state: z.string().optional(), kind: z.string(), expected: z.string().optional(), actual: z.string().optional() }).optional(),
  /** Ids of the duplicates folded into this finding by `mergeDuplicateFindings`. */
  merged: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof Finding>;

/** Pack ids equal the Hardness stage names they run. */
export const PackId = z.enum([
  "setup",
  "triage",
  "test_design",
  // The planner: runs in the test_design state (the machine's RUNS_IN), as the first half of the plan stage.
  "plan",
  // The fast lane's planner and test designer: the same stage, at low effort, for a small low-risk ticket.
  "plan_fast",
  "test_design_fast",
  "implementing",
  // Build's tests step: one failing test per scenario, written before the implementer runs; it runs in the implementing state.
  "build_tests",
  "verifying",
  "e2e",
  "evidence",
  "ci_watch",
  "reviewing_memory",
  "reviewing",
  "addressing",
  // Not a task stage: the Slack inbox's triage, run as a pack with no worktree.
  "slack_triage",
  // Not a task stage either: reads a Jira issue before it becomes a ticket (read-only on the repo).
  "jira_intake",
  // A decision before intake: labels an issue (kind, area, ready, size) on a decision model.
  "triage_signals",
  // Decisions on the plan stage's output (a plan context, run on demand): its risk, whether the scenarios cover the criteria, whether the plan fits the record.
  "risk_score",
  "coverage_check",
  "plan_check",
  // Decisions on the Build stage's own work (a check context, run on demand by the build watch): is a red right, is a change in scope.
  "red_check",
  "scope_check",
  // A decision on why a Build escalated (an escalation context, run on demand): the reason, with a confidence.
  "escalation_reason",
  // Decisions on Verify's own work (a check context, run on demand): how severe a review finding is, why a browser run failed.
  "finding_classify",
  // Confirms a finding a review helper made that the main reviewer did not.
  "finding_confirm",
  "e2e_failure_cause",
  // A decision on what kind of CI failure a red job is (a check context, run on demand): a real failure, a flake, an environment failure, a drift from the base.
  "ci_failure_class",
  // A decision on whether the text read off a film or screenshots shows a credential or personal data (a check context of kind frames): what no pattern decides.
  "frame_privacy",
  // Not a task stage: the replay evals' judge, grading another pack's answer to an eval case.
  "eval_judge",
  // Not a task stage: triages a batch of chat items (Slack or Teams) a client sends to POST /runs.
  "chat_triage",
  // Opens the plan stage (runs in test_design): reads the repo's code graph and names the components, files and owners the goal touches.
  "code_map",
  // A decision on Evidence (an evidence context, run on demand): which format shows the change best.
  "evidence_format",
  // Decisions on change size (wave 15): how big a change is, and whether a proposed split is sound.
  "size_estimate",
  "split_check",
  // The decomposer (wave 15): proposes the children of a split; an agent pack with no tools, on demand.
  "decompose",
  // Evidence's video pipeline (they run in the evidence state): the script and timeline, the recording of the approved steps, the cold critic, one fix round.
  "video_script",
  "recording",
  "video_qa",
  "video_fix",
  // Ship's decisions (a ship context, run on demand): what a review event is, what a comment asks, how far a fix reaches, whether the pack is still true, whether a retro would teach anything.
  "event_class",
  "comment_intent",
  "fix_scope",
  "evidence_valid",
  "worth_learning",
  // A decision at Intake (a dedup context, run on demand): is a new report the same problem as one of the five nearest cards.
  "intake_dedup",
  // A decision at the Ticket Machine (a ticket context, run on demand): can this ticket be worked on at all.
  "ticket_validity",
  // A decision at the Ticket Machine: the four typed answers of an assessment (urgency, complexity, blast radius, risk of doing against not doing).
  "ticket_assess",
  // A decision at the Conversation Machine (a conversation context, run on demand): the kind of a Slack thread, whether it needs a reply, three knock-outs and five scores.
  "conversation_assess",
  // A decision at the Conversation Machine over the same context: is the thread about one of the candidates, and does it ask for new work.
  "conversation_relation",
  // Drafts the reply to a Slack thread from the card's state, its Evidence Pack and the repository's docs, all as data; the draft waits for a person.
  "conversation_reply",
  // A decision at the Ticket Machine: what to do with a scored ticket where the scores alone cannot tell (do now, schedule, decline, needs decision).
  "ticket_recommend",
  // A decision on a PR under review (a PR-link context, run on demand): which open Jira ticket or board card, if any, the PR implements; the machine asks it only when no fact linked the review.
  "pr_link",
  // Drafts the reply that declines a ticket, from the ticket and its assessment as data; the draft waits for a person.
  "ticket_reply",
  // The loop guard's judge (a check context of kind loop, run on demand by the build watch): is a run stuck, and why.
  "loop_judge",
  // Writes the note that redirects a run the judge found stuck, from the same digest; an agent pack with no tools, on demand.
  "loop_redirect",
  // Proposes facts about a repository from the digests of its last runs, on demand after every few closed cards; an agent pack with no tools.
  "fact_propose",
  // Drafts the answer to a reviewer's question on a shipped PR from the Evidence Pack (runs in the shipping state, after the retro in PACKS order).
  "pr_reply",
  // The foreman: answers a question about the board from a snapshot and suggests actions the person confirms; no tools, no worktree, on demand (POST /foreman).
  "foreman",
  // Plans a ticket with a person over a read-only checkout; it only drafts, the board creates it (on demand).
  "ticket_chat",
  // The plan council (run in test_design after plan_check): a security review and an independent second opinion on a High-risk or large plan.
  // Reads the card's Figma design through the bridge and writes the spec the planner reads (RFC 0013): a sub-run of the plan stage, and on demand.
  "design_spec",
  // Audits the rendered change for WCAG 2.2 in the QA browser (RFC 0013): a sub-run of the e2e stage after a passing browser run, and on demand.
  "a11y_audit",
  // Compares the captured build with its Figma frames (RFC 0013, phase 3): a sub-run of the e2e stage after a passing browser run, read-only.
  "design_parity",
  // The writable UI helper of the implementer (RFC 0013, phase 5): builds one pure UI slice in its own container and on its own branch, started and picked by the machine; never a subagent.
  "ui_design",
  "council_security",
  "council_second",
  // The question council (run in triage before the person is asked): settles open questions from the code and the card, or says it cannot.
  "question_council",
  // Explains why a merged PR missed a change-management control, from its title, body and the machine's facts; no tools, no worktree, on demand.
  "change_exceptions",
  // Reviews a PR's diff against the regimes the repo declares (luna.yaml `compliance`): a lead that dispatches one reviewer per regime; runs beside reviewing and verifying, never as their helper.
  "compliance_review",
  // The dedicated passes of a PR review (security, migration, infrastructure, a second opinion): each a sub-run beside `reviewing`, never a stage of its own.
  "review_security",
  "review_migration",
  "review_iac",
  "review_second",
  // Suggests, for each flag of a GitHub org's quarterly access review, whether to keep, remove, reduce or investigate the access; no tools, no worktree, on demand.
  "access_review",
  // A decision at the incident job (RFC 0008, wave 5): did an incident expose personal data or health information, whose, and how many people.
  "breach_assess",
  // A decision at the weekly status job (RFC 0008, wave 7): does the ranked work of the coming week fit the agents' headroom and the person's review time.
  "capacity_check",
  // The engineering manager's weekly status for leadership, from the board's facts of the week; no tools, no worktree, on demand.
  "status_report",
  // Writes the blameless postmortem of a resolved incident from its facts, timeline and breach clocks; no tools, no worktree, on demand.
  "postmortem",
  // Names the doc sections a change made stale: advisory, read-only, run beside Verify; never a stage of its own.
  "docs_drift",
  // Answers a customer's security questionnaire from the product wiki's policy pages and the answer bank; no tools, no worktree, on demand.
  "questionnaire",
  // Turns one Dependabot or code-scanning alert into a work item with a lane and a deadline; no tools, no worktree, on demand.
  "vuln_triage",
  // Drafts the user-facing notes of a release from the merged PRs; no tools, no worktree, on demand.
  "release_notes",
]);
export type PackId = z.infer<typeof PackId>;

/** An engine per pack: a task's own overrides (`stages`), or a repo's luna.yaml `engines`. Each must
 *  be one of its pack's `engines.allowed`; the machine checks that against the pack registry. */
export const StageEngines = z.partialRecord(PackId, EngineId);
export type StageEngines = z.infer<typeof StageEngines>;

/** An effort per pack: a repo's luna.yaml `effort`, over the pack's own. The machine checks it
 *  against the engine that runs (`effortProblem`). */
export const StageEfforts = z.partialRecord(PackId, EffortId);
export type StageEfforts = z.infer<typeof StageEfforts>;

/** The ordered slices the planner proposes; `touchpoints` are repo-relative paths. */
export const Slice = z.object({
  title: z.string(),
  est_loc: z.number().int(),
  touchpoints: z.array(z.string()),
  acceptance: z.array(z.string()),
});
export type Slice = z.infer<typeof Slice>;

/** One behaviour test_design names: the plan criterion it proves, and how to prove it. The same schema as
 *  the v2.2 `Scenario` (plan.ts), kept under its old name for existing call sites. */
export const TestCase = Scenario;
export type TestCase = Scenario;

/** Schema 2's shape, read for runs recorded before the schema 3 rename. */
const LegacyTestCase = z.object({
  title: z.string(),
  criterion: z.string().nullable(),
  test: z.string(),
});

/** One scenario verifying proved (or didn't), alongside its code review. */
export const VerifyResult = TestCase.extend({ outcome: z.enum(["pass", "fail"]) });
export type VerifyResult = z.infer<typeof VerifyResult>;

/** The PR, its checks and the failed run's log tail, as ci_watch receives them. */
export const CiContext = z.object({
  pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
  checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string().nullable() })),
  logs: z.string().nullable(),
});
export type CiContext = z.infer<typeof CiContext>;

const PrFacts = z.object({
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  author: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
});

/** A Jira ticket the PR names, as the reviewer checks the change against it (foreign text: rendered as quoted data). */
export const ReviewTicket = z.object({
  key: z.string(),
  url: z.string(),
  type: z.string(),
  status: z.string(),
  summary: z.string(),
  /** Plain text, capped by the host. */
  description: z.string(),
  /** The issue's acceptance criteria when its description has a section for them; null otherwise. */
  acceptanceCriteria: z.string().nullable(),
});
export type ReviewTicket = z.infer<typeof ReviewTicket>;

/** A board card the review is linked to, as the reviewer checks the change against it (foreign text: rendered as quoted data). */
export const ReviewCard = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** The card's acceptance criteria, as plain lines. */
  criteria: z.array(z.string()),
  /** The card's description, an excerpt capped by the host. */
  description: z.string(),
});
export type ReviewCard = z.infer<typeof ReviewCard>;

/** For reviewing (a PR task): what the host fetched about someone's PR. */
export const ReviewContext = z.object({
  pr: PrFacts,
  /** `gh pr diff` output, tail-capped by the host. */
  diff: z.string(),
  files: z.array(z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int(), /** The name a renamed file had before. */ previousPath: z.string().optional() })),
  existingComments: z.array(
    z.object({ path: z.string().nullable(), line: z.number().int().nullable(), author: z.string(), body: z.string() }),
  ),
  /** The Jira tickets the PR names (title, head branch, body), when Jira is connected; absent reads as none linked. */
  tickets: z.array(ReviewTicket).optional(),
  /** The board cards the review is linked to (by a fact, or by the pr_link decision); absent reads as none. Their criteria and description are a spec too. */
  cards: z.array(ReviewCard).optional(),
});
export type ReviewContext = z.infer<typeof ReviewContext>;

/** For addressing (a PR task): the unresolved review threads on your PR, with the ids the host resolves them by. */
export const ThreadsContext = z.object({
  pr: PrFacts,
  threads: z.array(
    z.object({
      id: z.string(),
      path: z.string().nullable(),
      line: z.number().int().nullable(),
      /** `association` is GitHub's author association of the comment (OWNER, MEMBER, COLLABORATOR, NONE, ...); absent reads as not trusted. */
      comments: z.array(z.object({ author: z.string(), body: z.string(), at: z.string(), association: z.string().nullable().optional() })),
    }),
  ),
});
export type ThreadsContext = z.infer<typeof ThreadsContext>;

/** For slack_triage: one person's inbox batch, as the machine gathered it. `rules` is the
 *  text of the rules file's VIPs, Notes and Learned sections; a watch counts as the person. */
export const SlackTriageContext = z.object({
  me: z.object({ id: z.string(), name: z.string() }),
  watches: z.array(z.object({ label: z.string(), kind: z.string() })),
  rules: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      channel: z.string(),
      author: z.string(),
      isBot: z.boolean(),
      text: z.string(),
      /** Earlier messages of the thread, oldest first. */
      context: z.array(z.object({ user: z.string(), text: z.string() })),
      /** Why it is in the inbox: `me`, `usergroup:S…`, `broadcast:here`, `keyword:…`, `channel:C…`, `dm`. */
      matched: z.array(z.string()),
      threadReplies: z.number().int(),
    }),
  ),
});
export type SlackTriageContext = z.infer<typeof SlackTriageContext>;

/** For chat_triage: a batch of one person's chat items, Slack or Teams, as a client read them.
 *  Shaped so the notch's SlackItem and TeamsItem both fit; the answer is SlackTriageAnswer's. */
export const ChatTriageContext = z.object({
  source: z.enum(["slack", "teams"]),
  me: z.object({ id: z.string(), name: z.string() }),
  /** The person's rules as markdown (VIPs, always-P0 words, notes), when the client keeps any. */
  rules: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        /** Where it was said, as the client names it: `#eng`, `Ana`, `Platform › incidents`, a meeting's topic. */
        place: z.string(),
        /** Slack's dm, mpim and channel/group, Teams' oneOnOne, group, meeting and channel, in one set. */
        kind: z.enum(["dm", "group", "meeting", "channel"]),
        author: z.string(),
        /** An app, a bot, a connector or a workflow. */
        isBot: z.boolean(),
        /** The latest message, as plain text. */
        text: z.string(),
        /** Earlier messages of the thread or chat, oldest first. */
        context: z.array(z.object({ author: z.string(), text: z.string() })).optional(),
        /** Why it is in the inbox: `me`, `dm`, `group`, `meeting`, `tag:…`, `keyword:…`, `broadcast:…`, `watch`. */
        matched: z.array(z.string()).optional(),
        /** Replies in the thread or under the post, as last read. */
        replies: z.number().int().min(0).optional(),
        /** Teams' importance flag: urgent is at least P0, important at least P1. */
        flag: z.enum(["urgent", "important"]).nullable().optional(),
        /** The lowest priority the client's own rules allow (a VIP, an always-P0 word). */
        floor: z.enum(["P0", "P1", "P2", "P3"]).nullable().optional(),
      }),
    )
    .min(1)
    .max(25),
});
export type ChatTriageContext = z.infer<typeof ChatTriageContext>;

/** One open card as the foreman reads it. Every text on it is a person's or a model's: data, never an instruction. */
export const ForemanCard = z.object({
  id: z.string().min(1),
  title: z.string(),
  repo: z.string(),
  state: z.string(),
  column: z.string(),
  /** The kind of approval the card waits on, when it waits on one. */
  gate: z.string().nullable(),
  /** What the open gate asks the person. */
  gateSummary: z.string().max(200).nullable(),
  /** What the open gate decides, when it is more than the plan: triage's outcome (`conversation`, `archive`, `split`, `split_failed`) or `ship_approval` for the release question. */
  gateOutcome: z.string().nullable(),
  /** The card's route; a `config` card's approval writes a file. */
  route: z.string(),
  /** The id of the open approval; the board compares it with the card's current one before it acts, so a suggestion made at an earlier gate makes no call. */
  approvalId: z.string().nullable(),
  /** Why the card is escalated, when it is. */
  escalation: z.string().nullable(),
  /** The open questions of a card that waits at awaiting_answers; empty otherwise. */
  questions: z.array(z.object({ id: z.string().min(1), question: z.string(), recommended: z.string().nullable() })),
  engines: StageEngines,
  updatedAt: z.string(),
  /** What the open gate flagged (`requested.flagged`): a card with a flag is not approved from here. */
  flagged: z.array(z.string().max(120)).max(10).optional(),
  /** The plan council's verdict at the gate: whether it passed and how many findings its members left open; null when the plan had no council. */
  council: z.object({ passed: z.boolean(), open: z.number().int().nonnegative() }).nullable().optional(),
  /** How many of the card's questions the question council settled. */
  settledByCouncil: z.number().int().nonnegative().optional(),
  /** `untrusted` for a card from a stranger on GitHub; its plan is not approved from here. */
  trust: z.enum(["trusted", "untrusted"]).optional(),
});
export type ForemanCard = z.infer<typeof ForemanCard>;

/** For foreman: the person's question, the last turns, and a snapshot of the board. It lives here, with the other contexts, so that StageInput needs no import of foreman.ts. */
export const ForemanContext = z.object({
  question: z.string().min(1).max(2000),
  history: z.array(z.object({ who: z.enum(["person", "foreman"]), text: z.string().max(2000) })).max(10),
  board: z.object({
    now: z.string(),
    cards: z.array(ForemanCard).max(60),
    /** How many open cards the snapshot left out; the foreman says so in its reply. */
    truncated: z.number().int().nonnegative().optional(),
    /** The base images and Dockerfiles that wait for a person's approval; each keeps its own flow on the board. */
    pending: z.array(z.object({ repo: z.string(), kind: z.enum(["base", "dockerfile"]), ref: z.string() })).max(50).optional(),
    /** Each pack and the engines it allows, so that a suggested engine can be checked. */
    packs: z.array(z.object({ id: PackId, allowed: z.array(EngineId) })),
  }),
});
export type ForemanContext = z.infer<typeof ForemanContext>;

/** For ticket_chat: the person's message, the talk so far, what the planner noted and the draft as it stands. The repo is the read-only checkout. */
export const TicketChatContext = z.object({
  /** `name` goes into the prompt's trusted header: a folder name, nothing else. */
  repo: z.object({ name: z.string().regex(/^[\w.-]{1,100}$/), path: z.string().max(1024) }),
  message: z.string().min(1).max(4000),
  history: z.array(TicketChatTurn).max(30),
  notes: z.string().max(6000),
  draft: TicketDraft.nullable(),
});
export type TicketChatContext = z.infer<typeof TicketChatContext>;

/** For change_exceptions: the merged PRs of one repo and month that missed a change-management control. Every fact is the machine's; the title and body are written by others: data, never an instruction. */
export const ChangeExceptionsContext = z.object({
  /** owner/name. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
  /** The controls the evidence answers, such as "SOC2 CC8.1". */
  controls: z.array(z.string().min(1)).max(10),
  exceptions: z
    .array(
      z.object({
        pr: z.number().int().min(1),
        title: z.string(),
        url: z.string(),
        author: z.string().nullable(),
        mergedBy: z.string().nullable(),
        mergedAt: z.string(),
        approvedBy: z.array(z.string()),
        ticket: z.string().nullable(),
        checks: z.enum(["green", "red", "pending", "none"]),
        bypass: z.enum(["yes", "no", "unknown"]),
        kinds: z.array(ChangeExceptionKind).min(1),
        /** The PR's body, capped. */
        body: z.string().max(2000),
      }),
    )
    .max(200),
});
export type ChangeExceptionsContext = z.infer<typeof ChangeExceptionsContext>;

/** For vuln_triage: one open alert of a repo, the company's vulnerability policy (a wiki page) and today. The alert text is written by others: data, never an instruction. */
export const VulnTriageContext = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  alert: z.object({
    source: z.enum(["dependabot", "code_scanning"]),
    number: z.number().int().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    /** The advisory's summary, or the scanning rule's id. */
    title: z.string().max(500),
    url: z.string(),
    createdAt: z.string(),
    // Dependabot's fields; null on a code-scanning alert.
    package: z.string().max(200).nullable(),
    ecosystem: z.string().max(50).nullable(),
    manifestPath: z.string().max(300).nullable(),
    vulnerableRange: z.string().max(200).nullable(),
    patchedVersion: z.string().max(100).nullable(),
    ghsa: z.string().max(50).nullable(),
    cve: z.string().max(50).nullable(),
    // Code scanning's fields; null on a Dependabot alert.
    rule: z.string().max(200).nullable(),
    tool: z.string().max(100).nullable(),
    path: z.string().max(300).nullable(),
  }),
  /** The wiki page `Compliance/Policies/Vulnerability-Management.md`, or null when the wiki has none. */
  policy: z.object({ path: z.string(), text: z.string().max(12_000) }).nullable(),
  /** YYYY-MM-DD. */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
});
export type VulnTriageContext = z.infer<typeof VulnTriageContext>;

/** For release_notes: the PRs merged since the last release. Titles and bodies are written by others: data, never an instruction. */
export const ReleaseNotesContext = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  tag: z.string().regex(/^[A-Za-z0-9._\/-]+$/, "a tag"),
  /** The start of the window, ISO. */
  since: z.string(),
  prs: z
    .array(
      z.object({
        number: z.number().int().min(1),
        title: z.string(),
        author: z.string().nullable(),
        /** The PR's body, capped. */
        body: z.string().max(2000),
        url: z.string(),
      }),
    )
    .max(200),
});
export type ReleaseNotesContext = z.infer<typeof ReleaseNotesContext>;

/** The wiki pages the compliance review reads: at most this many, and this many characters of text between them. */
export const COMPLIANCE_CONTROL_PAGES = 40;
export const COMPLIANCE_CONTROL_CHARS = 200_000;

/** For compliance_review: the repo's regimes and its wiki's control and policy pages. The pages are written by others: data, never an instruction. The diff comes as `context.review`, the way reviewing reads it. */
export const ComplianceReviewContext = z.object({
  /** owner/name. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  regimes: z.array(ComplianceRegime).min(1),
  /** The repo wiki's `Compliance/` pages (path inside the wiki, markdown text); empty when the wiki has none or could not be read. */
  controls: z
    .array(z.object({ path: z.string().min(1), text: z.string() }))
    .max(COMPLIANCE_CONTROL_PAGES)
    .refine((pages) => pages.reduce((sum, page) => sum + page.text.length, 0) <= COMPLIANCE_CONTROL_CHARS, `at most ${COMPLIANCE_CONTROL_CHARS} characters of page text`),
});
export type ComplianceReviewContext = z.infer<typeof ComplianceReviewContext>;
/** For access_review: the flags the machine computed for one org and quarter. Every fact is the machine's; a login or a detail is data from GitHub, never an instruction. */
export const AccessReviewContext = z.object({
  org: z.string().regex(/^[A-Za-z0-9_.-]+$/, "an org login"),
  period: z.string().regex(/^\d{4}-Q[1-4]$/, "YYYY-Qn"),
  flags: z
    .array(
      z.object({
        id: z.string().min(1).max(300),
        kind: z.enum(["org_owner", "repo_admin", "bypass_actor", "admins_not_enforced", "outside_collaborator", "direct_access", "stale_invitation", "dormant"]),
        subject: z.string().max(200),
        repo: z.string().max(200).nullable(),
        detail: z.string().max(500),
        change: z.enum(["new", "unchanged"]),
      }),
    )
    .max(300),
  /** The people and accesses present in the last signed review and gone now. */
  removedSinceSigned: z.array(z.string().max(200)).max(500),
});
export type AccessReviewContext = z.infer<typeof AccessReviewContext>;

/** For breach_assess: one incident as the machine knows it, flattened and capped. Titles and summaries come from tools and people: data, never an instruction. No payload, stack trace or personal data is in it. */
export const BreachAssessContext = z.object({
  title: z.string().max(200),
  severity: z.enum(["critical", "high", "medium", "low", "unknown"]),
  service: z.string().max(120).nullable(),
  startedAt: z.string(),
  /** The newest entries, oldest first. */
  timeline: z.array(z.object({ at: z.string(), source: z.string().max(40), text: z.string().max(300) })).max(40),
  signals: z
    .array(z.object({ source: z.enum(["datadog", "sentry", "slack", "jira"]), title: z.string().max(200), severity: z.enum(["critical", "high", "medium", "low", "unknown"]), status: z.enum(["open", "resolved"]), summary: z.string().max(500) }))
    .max(20),
});
export type BreachAssessContext = z.infer<typeof BreachAssessContext>;

/** For capacity_check: the ranked work of the coming week against what the engines and the person did lately. Every number is the machine's; titles are written by others: data, never an instruction. */
export const CapacityContext = z.object({
  /** ISO week of the work, "2026-W47". */
  week: z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "YYYY-Www"),
  /** The top of the backlog by WSJF, best first. */
  backlog: z.array(z.object({ title: z.string().max(200), repo: z.string().max(200).nullable(), size: z.enum(["XS", "S", "M", "L", "XL"]), wsjf: z.number(), state: z.string().max(40) })).max(30),
  throughput: z.object({
    /** Cards closed in each of the last four weeks, oldest first. */
    closedPerWeek: z.array(z.number().min(0)).max(4),
    /** PRs the person reviewed or approved in each of the last four weeks, oldest first. */
    reviewedPerWeek: z.array(z.number().min(0)).max(4),
  }),
  /** What each engine has left: the budget (null when it has none to spend) and the hours it was rate limited lately. */
  headroom: z.array(z.object({ engine: z.string().max(60), budgetLeftUsd: z.number().nullable(), rateLimitedHours: z.number().min(0) })).max(20),
});
export type CapacityContext = z.infer<typeof CapacityContext>;

/** For status_report: one week's facts, all computed by the machine; titles and reasons are written by others: data, never an instruction. */
export const StatusReportContext = z.object({
  /** ISO week, "2026-W46". */
  week: z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "YYYY-Www"),
  /** The Monday and the Sunday of the week, YYYY-MM-DD. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metrics: z.object({
    created: z.number().min(0),
    closed: z.number().min(0),
    open: z.number().min(0),
    waitingOnYou: z.number().min(0),
    /** Median hours from created to merged, for the cards merged in the week. */
    leadTimeHours: z.number().min(0).nullable(),
    /** Share of tasks whose first verifying run passed, 0 to 1. */
    firstPassRate: z.number().min(0).max(1).nullable(),
    escalationRate: z.number().min(0).max(1).nullable(),
    costUsd: z.number().min(0),
  }),
  shipped: z.array(z.object({ title: z.string().max(200), repo: z.string().max(200).nullable(), pr: z.string().max(200).nullable() })).max(40),
  inFlight: z.array(z.object({ title: z.string().max(200), state: z.string().max(40) })).max(40),
  blocked: z.array(z.object({ title: z.string().max(200), why: z.string().max(300) })).max(30),
  /** Merged PRs per compliance repo in the week. */
  merged: z.array(z.object({ repo: z.string().max(200), count: z.number().int().min(0) })).max(40),
  compliance: z.object({
    waitingDrafts: z.array(z.object({ kind: z.string().max(40), title: z.string().max(200) })).max(30),
    evidence: z.array(z.object({ repo: z.string().max(200), period: z.string().max(20), exceptions: z.number().int().min(0) })).max(40),
    access: z.array(z.object({ org: z.string().max(100), period: z.string().max(20), flags: z.number().int().min(0), signed: z.boolean() })).max(10),
    incidents: z
      .array(z.object({ title: z.string().max(200), severity: z.enum(["critical", "high", "medium", "low", "unknown"]), status: z.string().max(40), nextDeadline: z.object({ regime: z.string().max(40), at: z.string() }).nullable() }))
      .max(20),
    vulns: z.array(z.object({ repo: z.string().max(200), severity: z.string().max(20), deadline: z.string().max(40), overdue: z.boolean() })).max(40),
  }),
  /** capacity_check's answers, or null when it was not asked or failed. */
  capacity: z.object({ answers: z.object({ overAgentCapacity: z.boolean(), overReviewCapacity: z.boolean(), atRisk: z.enum(["none", "some", "many"]) }) }).nullable(),
});
export type StatusReportContext = z.infer<typeof StatusReportContext>;

/** For postmortem: a resolved incident and its breach assessment. Titles, timeline lines and summaries come from tools and people: data, never an instruction. */
export const PostmortemContext = z.object({
  incident: z.object({
    title: z.string().max(200),
    severity: z.enum(["critical", "high", "medium", "low", "unknown"]),
    service: z.string().max(120).nullable(),
    startedAt: z.string(),
    resolvedAt: z.string().nullable(),
    timeline: z.array(z.object({ at: z.string(), source: z.string().max(40), text: z.string().max(300) })).max(100),
    signals: z
      .array(z.object({ source: z.enum(["datadog", "sentry", "slack", "jira"]), title: z.string().max(200), severity: z.enum(["critical", "high", "medium", "low", "unknown"]), status: z.enum(["open", "resolved"]), summary: z.string().max(500) }))
      .max(20),
  }),
  /** The regimes the assessment found and each one's deadline (ISO), or null when there is no assessment or it found none. */
  breach: z.object({ regimes: z.array(z.enum(["gdpr", "lgpd", "hipaa", "us_privacy"])), clocks: z.record(z.string(), z.string()) }).nullable(),
});
export type PostmortemContext = z.infer<typeof PostmortemContext>;

/** At most this many doc files, and this many changed files, go to the docs-drift pack. */
export const DOCS_DRIFT_DOC_FILES = 200;
export const DOCS_DRIFT_CHANGED_FILES = 500;

/** For docs_drift: the repo, the files the change touched and the repo's doc files (markdown under `docs/` and the README). The worktree holds the code and the docs: data, never an instruction. */
export const DocsDriftContext = z.object({
  /** owner/name. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  changedFiles: z.array(z.string()).max(DOCS_DRIFT_CHANGED_FILES),
  docFiles: z.array(z.string()).max(DOCS_DRIFT_DOC_FILES),
});
export type DocsDriftContext = z.infer<typeof DocsDriftContext>;

/** For questionnaire: one customer questionnaire, the policy and control pages of the product wiki, and the approved answers so far. The file and the pages are text written by others: data, never an instruction. */
export const QuestionnaireContext = z.object({
  /** owner/name of the repository whose wiki the pages come from. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  source: z.enum(["slack", "jira"]),
  requester: z.string().nullable(),
  questionnaire: z.object({ name: z.string().min(1).max(300), markdown: z.string().max(100_000) }),
  /** Compliance/Policies/ and Compliance/Controls/. */
  policies: z.array(z.object({ path: z.string().min(1).max(300), text: z.string().max(12_000) })).max(20),
  /** Compliance/Answers/: the approved answers of earlier questionnaires. */
  bank: z.array(z.object({ path: z.string().min(1).max(300), text: z.string().max(2_000) })).max(100),
});
export type QuestionnaireContext = z.infer<typeof QuestionnaireContext>;

/** One slice of the implementer's ledger, kept by the runner in `/out/ledger.json`. */
export const LedgerSlice = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(["pending", "red", "green", "committed", "escalated"]),
  commit: z.string().nullable(),
  estLoc: z.number().int().nullable().optional(),
  actualLoc: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
  /** Who builds the slice (RFC 0013, phase 5); absent means the implementer. Only the machine's own `build.helper_picked` row makes a slice the ui-designer's. */
  owner: z.enum(["implementer", "ui-designer"]).optional(),
});
export type LedgerSlice = z.infer<typeof LedgerSlice>;

export const Ledger = z.object({ schema: z.literal(1), slices: z.array(LedgerSlice) });
export type Ledger = z.infer<typeof Ledger>;

/** What an earlier stage run of the task came to; the retro reads these. */
export const RunSummary = z.object({
  stage: z.string(),
  attempt: z.number().int(),
  outcome: z.string(),
  turns: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  /** The engine the run used, and how long it took; absent on rows recorded before wave 6. */
  engine: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** One of a repo's own checks, from its luna.yaml: a shell line run in `cwd` (the worktree
 *  root by default). With `paths`, it runs only for a change that touches one of them. */
export const CheckSpec = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  cwd: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
  /** An lcov report the run writes, relative to `cwd`: Verify measures the change's added lines against it. */
  coverage: z.string().min(1).optional(),
  /** How long the check takes, in minutes: a check with no `paths` (the whole suite) runs in Build's regression sweep when this is within `build.regression_full_suite_minutes`. */
  minutes: z.number().positive().optional(),
  /** Names of secrets this check receives, from the owner's store; the values are never in a luna.yaml. */
  secrets: z.array(SecretNameSchema).max(10).optional(),
});
export type CheckSpec = z.infer<typeof CheckSpec>;

/** How much of a change's added lines a repo's own lcov report saw run. */
export const CoverageSummary = z.object({
  files: z.array(z.object({ path: z.string(), added: z.number().int(), covered: z.number().int(), uncovered: z.array(z.number().int()) })),
  total: z.object({ added: z.number().int(), covered: z.number().int() }),
  /** The report's path, as the check named it. */
  report: z.string(),
});
export type CoverageSummary = z.infer<typeof CoverageSummary>;

/** A service a repo's code needs beside it (a database, a broker), from its luna.yaml. The
 *  machine runs it next to each stage and check container; `exports` is the env the code
 *  gets, with the service reachable by its key as hostname; `ready` is run inside the
 *  service until it exits 0. */
export const ServiceSpec = z.object({
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  ready: z.string().min(1).optional(),
  exports: z.record(z.string(), z.string()).optional(),
});
export type ServiceSpec = z.infer<typeof ServiceSpec>;

/** A repo's `luna.yaml` as data: what the setup pack proposes and what the machine reads.
 *  Unknown keys are ignored, so a newer file loads on an older machine. */
/** A duration in luna.yaml: `30m`, `4h`, `3d`, or `off`. */
export const Duration = z.string().regex(/^(\d+[mhd]|off)$/, "a duration like 30m, 4h, 3d, or off");

/**
 * How a repo's tasks talk to Jira. `on` maps a task state to the Jira status name the issue is
 * transitioned to when the task enters that state; states left out are never touched.
 */
export const JiraConfig = z.object({
  /** The project `J` creates issues in, and intake's default. */
  project: z.string().min(1).optional(),
  intake: z
    .object({
      jql: z.string().min(1),
      every: Duration.optional(),
    })
    .optional(),
  /** Keys are task states (`implementing`, `awaiting_ship`, `closed`, …); the machine rejects unknown ones. */
  on: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** What the machine writes back: nothing, the milestones (picked up, PR, closed), or every gate too. */
  comments: z.enum(["none", "milestones", "gates"]).optional(),
  /** Per task state, Jira fields to set; values may use `{pr_url}`, `{task_id}`, `{branch}`, `{board_url}`. */
  fields: z.record(z.string().min(1), z.record(z.string().min(1), z.string())).optional(),
  /** The branch name for a linked task: `{type}` (Jira issue type, lowercased), `{key}`, `{slug}`, `{route}`, `{id}`. */
  branch: z.string().min(1).optional(),
});
export type JiraConfig = z.infer<typeof JiraConfig>;

/** SLAs on the tickets themselves; the machine's defaults apply where a repo says nothing. */
export const SlaConfig = z.object({
  /** How long a task may wait on you at a gate. */
  gate: Duration.optional(),
  /** Per running stage, how long it may take. */
  /** Keyed by running stage name. */
  stage: z.record(z.string().min(1), Duration).optional(),
  /** Created to closed. */
  cycle: Duration.optional(),
  /** Archive a ticket left at an intake gate (setup, triage's questions) this long; off by default. */
  archive: Duration.optional(),
});
export type SlaConfig = z.infer<typeof SlaConfig>;

export const LunaConfig = z.object({
  // The v2.2 diagram's sections (config-v22.ts); `evidence` below carries its own keys.
  ...FactoryConfigInput,
  policy: z
    .object({
      qa: z.enum(["web", "none"]).optional(),
      monthly_budget_usd: z.number().positive().optional(),
      auto_approve_plan_minutes: z.number().int().positive().optional(),
      max_concurrent: z.number().int().positive().optional(),
      holdout_cases: z.boolean().optional(),
      // Whether the machine keeps a code graph of this repo for its stages (default on).
      graph: z.enum(["on", "off"]).optional(),
      // What the machine may merge by itself once a shipped PR is ready: nothing (default), low risk, or low and medium.
      auto_merge: z.enum(["off", "low", "medium"]).optional(),
      // Per decision pack, per question: the repo's own confidence bars over the pack's.
      decisions: z.record(z.string(), z.record(z.string(), ConfidencePolicySchema)).optional(),
    })
    .optional(),
  qa_targets: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().regex(/^https?:\/\//, "url must start with http:// or https://"),
        credential: z
          .string()
          .regex(/^env:[A-Z_][A-Z0-9_]*$/, "credential must be a reference like env:QA_PASSWORD, never a value")
          .optional(),
        /** False when the target must not be driven twice (e2e already drove it once, so the video recording is skipped); absent means true. */
        reentrant: z.boolean().optional(),
      }),
    )
    .optional(),
  checks: z.array(CheckSpec).optional(),
  services: z.record(z.string().min(1), ServiceSpec).optional(),
  toolchains: z.record(z.string().min(1), z.union([z.string(), z.number()])).optional(),
  jira: JiraConfig.optional(),
  sla: SlaConfig.optional(),
  /** The engine a pack runs on in this repo, over its default; a task's own choice wins over it. */
  engines: StageEngines.optional(),
  /** The effort a pack runs at in this repo, over its default. */
  effort: StageEfforts.optional(),
  /** The regimes this repo answers to; each makes the compliance review run that regime's reviewer. */
  compliance: z.array(ComplianceRegime).refine((regimes) => new Set(regimes).size === regimes.length, "each regime once").optional(),
  /** Monthly caps in USD on this repo's stage runs, by engine or credential (`openai:sol: 10`). */
  budget: z.object({ engines: EngineBudgets.optional() }).optional(),
  /** How long the machine keeps a task's local Evidence Pack and media; 0 never sweeps it, absent defers to MACHINE_RETENTION_DAYS. */
  evidence: z.object({ retention_days: z.number().int().min(0).optional(), ...EvidenceConfigV22 }).optional(),
  /** The designer agents in this repo (RFC 0013): `off`, or the machine's MCP servers narrowed by name. */
  design: DesignConfig.optional(),
  /** Windows in which the machine merges nothing, whatever the policy says. */
  freeze: z
    .array(
      z.object({
        from: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "from must be a date"),
        to: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "to must be a date"),
        reason: z.string().min(1),
      }),
    )
    .optional(),
});
export type LunaConfig = z.infer<typeof LunaConfig>;

/** A place the e2e stage may drive. `credential` is a reference (`env:NAME`), never a value. */
export const QaTarget = z.object({
  name: z.string(),
  baseUrl: z.string(),
  credential: z.string().nullable().optional(),
  /** False when the target must not be driven twice; absent means it may be. */
  reentrant: z.boolean().optional(),
});
export type QaTarget = z.infer<typeof QaTarget>;

/** What triage_signals said about the issue a task came from, as intake stores it: each answer's
 *  pick (`size` is the rubric score, 0 tiny to 3 large), the lowest of the answers' confidences,
 *  when and on which model. A hint for people and for jira_intake; it decides nothing alone. */
export const TaskClassification = z.object({
  kind: z.string(),
  /** How sure Jev is of the kind alone; what routing reads. Absent on classifications stored before it. */
  kindConfidence: z.number().min(0).max(1).optional(),
  /** The part of the repo a v1 answer named; v2 answers say `typeOfWork` instead. */
  area: z.string().optional(),
  ready: z.boolean(),
  size: z.number(),
  /** How soon (rubric score, 0 low to 3 urgent) and how risky (0 none to 3 high); absent on classifications stored before triage_signals asked. */
  urgency: z.number().optional(),
  risk: z.number().optional(),
  // v2 (wave 9): what the diagram's signals read; a classification stored before has none of them.
  typeOfWork: z.enum(["frontend", "backend", "infra", "data", "docs", "mixed"]).optional(),
  sizeBucket: z.enum(["XS", "S", "M", "L", "XL"]).optional(),
  /** The five urgency sub-scores, 1 to 3. */
  subScores: z.object({ who: z.number(), what: z.number(), impact: z.number(), time: z.number(), demand: z.number() }).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  riskPrelim: z.enum(["low", "medium", "high"]).optional(),
  /** The archive suggestion and why (`none` when it should be worked). */
  archive: z.boolean().optional(),
  archiveReason: z.string().optional(),
  confidence: z.number().min(0).max(1),
  at: z.string(),
  model: z.string(),
  /** The decision record this reading left (an id, never its content), so a person's correction can be written onto it as ground truth. */
  recordId: z.string().optional(),
  /** Every question's answer with its own confidence. */
  signals: z.record(z.string(), z.object({ answer: z.union([z.string(), z.number(), z.boolean(), z.null()]), confidence: z.number().min(0).max(1) })).optional(),
});
export type TaskClassification = z.infer<typeof TaskClassification>;

/** Why a task was archived instead of closed. `no_setup` and `no_answer`: nobody set the repo up, nobody answered triage's questions, within the SLA (`sla_expired` is what older cards carry). */
export const ArchiveReason = z.enum(["duplicate", "sla_expired", "rejected", "not_for_agent", "pr_closed", "no_setup", "no_answer", "split"]);
export type ArchiveReason = z.infer<typeof ArchiveReason>;

/** Why a stage stopped on purpose: `plan_wrong` the plan cannot be built as written (the planner runs again with the evidence),
 *  `env_broken` the sandbox or toolchain is, `flaky_tests` the tests do not hold still, `too_complex`
 *  the work is bigger than one stage, `undeclared_scope` it needs files or packages the plan did not name, `head_moved` the PR head moved after
 *  the evidence pack was made (Evidence runs again), `design_budget` the card's design budget is spent, `merge_conflict` the ui-designer's commits conflicted with the implementer's twice. */
export const EscalationReason = z.enum(["plan_wrong", "env_broken", "flaky_tests", "too_complex", "undeclared_scope", "head_moved", "design_budget", "merge_conflict", "other"]);
export type EscalationReason = z.infer<typeof EscalationReason>;

/** How risky a change or a ticket reads: on one scale for the triage record and the evidence pack. */
export const Risk = z.enum(["none", "low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

/** What triage decided about a ticket and why, kept on the task (RFC 0005): the ticket as the
 *  machine understood it, each signal with its confidence, the questions asked and the route taken. */
export const TriageRecord = z.object({
  source: z.string(),
  kind: z.string(),
  goal: z.string(),
  size: z.string(),
  urgency: z.string(),
  risk: Risk,
  /** What each decision question answered and how sure it was, by question name. */
  signals: z.record(z.string(), z.object({ answer: z.union([z.string(), z.number(), z.boolean(), z.null()]), confidence: z.number().min(0).max(1) })),
  /** Questions asked of the person who filed it, and what they said. */
  /** Who answered each question: absent means a person; `council` is the question council, with the places it read and the machine field (`kind`, `size`, `risk`) it settled, when the question was the machine's. */
  qa: z.array(z.object({ question: z.string(), answer: z.string().nullable(), by: z.enum(["person", "council"]).optional(), evidence: z.array(z.string()).optional(), field: z.string().optional() })),
  decision: z.enum(["plan", "fast_lane", "conversation", "archive"]),
  reason: z.string(),
  at: z.string(),
  model: z.string(),
  // v2.2, all optional: a record written before the wave has none of them. Wave 9 fills them.
  summary: z.string().optional(),
  typeOfWork: z.enum(["frontend", "backend", "infra", "data", "docs", "mixed"]).optional(),
  /** The goal this ticket serves: an id, or `none`. */
  goalRef: z.string().optional(),
  urgencyDetail: z
    .object({
      priority: z.enum(["P0", "P1", "P2", "P3"]),
      subScores: z.object({ who: z.number(), what: z.number(), impact: z.number(), time: z.number(), demand: z.number() }),
    })
    .optional(),
  riskPrelim: z.enum(["low", "medium", "high"]).optional(),
  /** The hints the filer gave that triage read. */
  hintsUsed: z.array(z.string()).optional(),
  decisionBy: z.enum(["machine", "person"]).optional(),
  /** The fields a person corrected (`kind`, `typeOfWork`, `size`, `riskPrelim`, `priority`); the rest are the machine's. */
  editedFields: z.array(z.enum(["kind", "typeOfWork", "size", "riskPrelim", "priority"])).optional(),
  /** The risk the machine itself composed the record with. A person's lower correction is kept and shown (`riskPrelim`), but `risk`, which the plan's floor and the approver and ship rules read, stays at the higher of the two. */
  riskMachine: z.enum(["low", "medium", "high"]).optional(),
  /** Why the fast lane was taken without the owners being checked (no graph, a stale one, no CODEOWNERS...); absent when they were. */
  ownersNotChecked: z.string().max(200).optional(),
  version: z.number().int().optional(),
});
export type TriageRecord = z.infer<typeof TriageRecord>;

/** What the plan stage's decisions read, and what its second round hands the planner and the test
 *  designer: the record, the plan, the scenarios so far, the criteria no scenario names (`gaps`,
 *  computed from `cases[].criterion`) and which round this is. */
/** What a file in the map is for: the change edits it, a read file is context, a test file is where its checks live. */
export const MapRole = z.enum(["change", "read", "test"]);
export type MapRole = z.infer<typeof MapRole>;

/** A file of the map. A plain string, as maps were written before roles, is a file to change. */
export const MapFile = z.preprocess(
  (value) => (typeof value === "string" ? { path: value, role: "change" } : value),
  z.object({ path: z.string(), role: MapRole.default("change") }),
);
export type MapFile = z.infer<typeof MapFile>;

export const CodeMapAnswer = z.object({
  /** The parts of the system the goal touches: graph communities or top-level folders. */
  components: z.array(z.string()),
  /** Repo-relative files the goal touches, deduplicated, at most 40, each with its role. */
  files: z.array(MapFile),
  /** Where the flow the goal changes starts: handlers, commands, jobs (symbols or paths). */
  entry_points: z.array(z.string()).default([]),
  /** Who owns those files: CODEOWNERS entries, else the top committers. */
  owners: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  /** What the mapper could not place. */
  note: z.string().optional(),
  /** Added by the machine, not the agent: the graph is more than `graph.stale_commits` behind the default branch. */
  stale: z.boolean().optional(),
  /** Added by the machine: paths the mapper named that were not plain repo-relative paths (a glob, an absolute path, `..`), dropped from `files`. */
  dropped: z.array(z.string()).optional(),
  /** Added by the machine: commits the default branch has over the graph's; null when it cannot be counted. */
  behind: z.number().int().nullable().optional(),
});
export type CodeMapAnswer = z.infer<typeof CodeMapAnswer>;

/** The risk a plan is written for and approved at: the level, and when risk_score ran the three scores (blast radius, reversibility, data sensitivity, each 0 to 2 on the wire), their product and the change's complexity. */
export const PlanRisk = z.object({
  /** The level the approvers rule and Ship read: the higher of the machine's and a person's edit. */
  level: Risk,
  /** The machine's own level (its floor), once a person has edited the level at the gate. */
  machine: Risk.optional(),
  product: z.number().optional(),
  scores: z.object({ blast_radius: z.number(), reversibility: z.number(), data_sensitivity: z.number() }).partial().optional(),
  complexity: z.enum(["S", "M", "L", "XL"]).optional(),
});
export type PlanRisk = z.infer<typeof PlanRisk>;

/** For question_council: the open questions (a machine question carries its field, guess and confidence; an agent question, nulls), the card and the answers so far. */
export const QuestionsContext = z.object({
  questions: z
    .array(z.object({ id: z.string().min(1), question: z.string(), recommended: z.string().nullable(), field: z.string().nullable(), guess: z.string().nullable(), confidence: z.number().nullable() }))
    .min(1)
    .max(6),
  card: z.object({ title: z.string(), description: z.string() }),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type QuestionsContext = z.infer<typeof QuestionsContext>;

/** One member's answer in the plan council: who, which round, what they said and the findings (none means nothing to add). */
export const CouncilTurn = z.object({ member: z.enum(["security", "second"]), round: z.union([z.literal(1), z.literal(2)]), summary: z.string(), findings: z.array(Finding) });
export type CouncilTurn = z.infer<typeof CouncilTurn>;

export const PlanContext = z.object({
  /** The machine's fact that every file the plan touches is documentation (or a test): the test designer writes reading checks, no test. */
  docsOnly: z.boolean().optional(),
  record: TriageRecord.nullable(),
  brief: z.string(),
  criteria: z.array(z.string()),
  assumptions: z.array(z.string()),
  slices: z.array(Slice),
  rollback: z.string().optional(),
  cases: z.array(TestCase).optional(),
  gaps: z.array(z.string()).optional(),
  /** What coverage found wrong with the last scenarios (criteria with no edge or failure scenario, a "does not pin"), for the designer's next round. */
  coverage_notes: z.array(z.string()).optional(),
  round: z.number().int().optional(),
  /** What plan_check found wrong with the last plan, for the planner's next round. */
  review: z.array(z.string()).optional(),
  /** The code map the plan stage opened with, for the planner and the decisions; null when the repo has no graph. */
  map: CodeMapAnswer.nullable().optional(),
  /** The risk scored before the plan, which the planner writes for. */
  risk: PlanRisk.optional(),
  /** A plan found wrong in Build, Verify or review is back with the planner: who raised it, why and the evidence (all data: flattened and capped by the machine). */
  replan: z.object({ raised_by: z.string(), reason: z.string(), output: z.string().optional(), findings: z.array(z.string()).optional(), thread: z.string().optional() }).optional(),
  /** For the code mapper: where the graph says the goal lives (the machine's lexical match), to confirm and give roles to. */
  shortlist: z.object({ files: z.array(z.string()), symbols: z.array(z.string()), components: z.array(z.string()), owners: z.array(z.string()) }).optional(),
  /** For the council packs: the plan under review as text, its criteria, the round and what the members said so far. */
  council: z.object({ plan: z.string(), criteria: z.array(z.string()), round: z.union([z.literal(1), z.literal(2)]), transcript: z.array(CouncilTurn) }).optional(),
  /** The design spec the plan stage opened with (RFC 0013), for the planner, as data; null when it could not be made. */
  designSpec: DesignSpec.nullable().optional(),
  /** For the test designer: the spec's frames by id, name, viewport and states, so a scenario may cite one (`frame_ref`). No tokens, no notes. */
  frames: z.array(z.object({ id: z.string(), name: z.string(), viewport: z.string().nullable(), states: z.array(z.string()) })).max(30).optional(),
});
export type PlanContext = z.infer<typeof PlanContext>;

/** What the checks (red_check, scope_check, finding_classify, e2e_failure_cause) judge: a red slice's failing output, the facts of a change's scope, a review finding, or a failed browser run. */
export const CheckContext = z.object({
  kind: z.enum(["red", "scope", "finding", "e2e", "escalation", "ci", "frames", "loop"]),
  /** loop: the guard's digest of a run's recent actions (counters, tool names, base names, error hashes: never file contents), the pack and how many calls it made; `cause` is what the judge found, for the redirect writer. All data. */
  loop: z.object({ digest: z.string().max(6000), pack: z.string().max(60), calls: z.number().int().nonnegative(), cause: z.string().max(40).optional() }).optional(),
  /** frames: the distinct on-screen texts of a film or its screenshots, flattened and capped by the machine (40 texts of 1000 characters): data for frame_privacy. */
  frames: z.object({ texts: z.array(z.string().max(1000)).max(40) }).optional(),
  /** ci: the failing job and the tail of its log, flattened and capped by the machine: data for ci_failure_class. */
  ci: z.object({ job: z.string(), log: z.string() }).optional(),
  slice: z.object({ id: z.number().int(), title: z.string(), acceptance: z.array(z.string()) }).optional(),
  /** escalation: why Build stopped, as data for escalation_reason: all text flattened and capped before it gets here. */
  escalation: z
    .object({
      stage: z.string(),
      summary: z.string(),
      /** What the agent itself said the reason was, when it said one. */
      agentReason: EscalationReason.nullable().optional(),
      agentWord: z.string().optional(),
      /** The tail of the last failing output. */
      output: z.string().optional(),
      /** What the machine knows: which limit was hit, how many runs. */
      facts: z.array(z.string()).optional(),
    })
    .optional(),
  /** red, for a scenario's test (Build's tests step): the scenario, and the machine's fact that its tagged test is in the diff. */
  scenario: z.object({ id: z.string(), title: z.string(), given: z.string().nullable().optional(), when: z.string().nullable().optional(), then: z.string().nullable().optional(), approach: z.string().optional() }).optional(),
  exists: z.boolean().optional(),
  /** red: the failing output's tail: the test writer's own report of it. */
  output: z.string().optional(),
  /** red: the tagged test's source, read by the machine from the worktree (capped): the writer's report alone is not evidence of why the test fails. */
  test: z.string().optional(),
  planned: z.array(z.string()).optional(),
  changed: z.array(z.string()).optional(),
  declared: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
  undeclared: z.array(z.string()).optional(),
  removedTests: z.array(z.string()).optional(),
  newDependencies: z.array(z.string()).optional(),
  todos: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  /** scope: tests switched off in place on an added line, and scenario ids whose tag the change removed. */
  switchedOff: z.array(z.string()).optional(),
  weakened: z.array(z.string()).optional(),
  diffSummary: z.string().optional(),
  /** finding: the finding to classify, and the file around its line as the machine read it. */
  finding: Finding.optional(),
  excerpt: z.string().optional(),
  /** e2e: the failed run, with the rows that did not pass. */
  e2e: z
    .object({
      verdict: z.enum(["fail", "partial"]),
      summary: z.string(),
      criteria: z.array(z.object({ text: z.string(), result: z.enum(["pass", "fail", "partial"]), note: z.string().optional() })),
      attempt: z.number().int(),
    })
    .optional(),
});
export type CheckContext = z.infer<typeof CheckContext>;

/** What shows a change does what the ticket asked, kept on the task for the person who approves it. */
export const EvidencePack = z.object({
  summary: z.string(),
  format: z.enum(["video", "captures", "text"]),
  scenarios: z.array(z.object({ text: z.string(), test: z.string().nullable(), result: z.enum(["pass", "fail", "partial", "skipped", "not_run"]) })),
  findings: z.array(z.string()),
  /** Changes outside what the plan mapped. */
  outOfMap: z.array(z.string()),
  risk: Risk,
  rollback: z.string(),
  howToVerify: z.string(),
  commitSha: z.string(),
  media: z.array(
    z.object({
      kind: z.enum(["video", "screenshot", "har", "report", "cover", "captions", "audio"]),
      label: z.string(),
      url: z.string(),
      /** v2.2: where the file is on the machine, when `url` is not that path. */
      localPath: z.string().optional(),
      /** v2.2, wave 12b: whether the text on this image was read for secrets and personal data; false when the reader could not run. */
      scanned: z.boolean().optional(),
    }),
  ),
  /** The narrated walkthrough, when the format is video: where it is, the critic's verdict and scores, its defects, the rounds spent. */
  video: z
    .object({
      file: z.string(),
      durationS: z.number(),
      verdict: z.enum(["ship", "one_more_pass", "degraded"]),
      scores: z.record(z.string(), z.number()),
      defects: z.array(z.object({ priority: z.enum(["P0", "P1", "P2"]), t: z.number(), scene: z.string().nullable(), element: z.string().nullable(), symptom: z.string(), fix: z.string() })),
      rounds: z.number().int(),
      transcript: z.string().optional(),
      /** The critic's confidence in its verdict, 0 to 1, when it gave one. */
      confidence: z.number().min(0).max(1).optional(),
    })
    .nullable()
    .optional(),
  /** Why a format was degraded (video to captures, captures to text). */
  note: z.string().optional(),
  at: z.string(),
  // v2.2, all optional: a pack made before the wave has none of them. Filled from the Verify Report when one exists.
  results: z
    .object({
      unit: z.object({ passed: z.number().int(), total: z.number().int() }).nullable(),
      integration: z.object({ passed: z.number().int(), total: z.number().int() }).nullable(),
      e2e: z.object({ verdict: z.string().nullable(), passed: z.number().int(), total: z.number().int() }).nullable(),
      coverageDelta: z.object({ added: z.number().int(), covered: z.number().int() }).nullable(),
    })
    .optional(),
  findingsDetail: z.array(z.object({ id: z.string(), title: z.string(), severity: z.string(), resolution: z.string().nullable(), inferred: z.boolean().optional() })).optional(),
  previewUrl: z.string().optional(),
  version: z.number().int().optional(),
  // v2.2, wave 12b, all optional.
  /** What the change was and why, in the implementer's words, and its size: from the Build Report. */
  diffSummary: z.object({ what: z.string(), why: z.string(), files: z.array(z.string()), added: z.number().int().nullable(), removed: z.number().int().nullable() }).optional(),
  /** How many packs this card has had: 1 for the first, the stored one plus one after. (`version` is the schema's.) */
  revision: z.number().int().min(1).optional(),
  /** The fixes pushed after review, oldest first (20 at most): the commit, its scope, a line and when. */
  fixes: z.array(z.object({ sha: z.string(), scope: z.enum(["in_place", "re_verify_partial"]), summary: z.string(), at: z.string() })).max(20).optional(),
  /** What the pack was made from, so a new head re-makes only what it made stale: the browser run, a hash of the approved scenarios, the sha256 of the run's steps. */
  source: z.object({ e2eRunId: z.string().nullable(), scenariosKey: z.string(), stepsSha: z.string().nullable() }).optional(),
  /** Set by the publish step, once the section or comment is on the PR: the board shows it as published, whatever media the pack has (a text-only pack has no link to tell). */
  published: z.boolean().optional(),
});
export type EvidencePack = z.infer<typeof EvidencePack>;

/** What evidence_format reads: the record, the risk, whether the change has a web surface, what the browser run left, and whether the video image exists. */
export const EvidenceContext = z.object({
  record: TriageRecord.nullable(),
  risk: Risk.nullable(),
  webSurface: z.boolean(),
  e2e: z.object({
    ran: z.boolean(),
    verdict: z.string().nullable(),
    hasVideo: z.boolean(),
    hasSteps: z.boolean(),
    scenarios: z.number().int(),
    skippedReason: z.string().nullable(),
  }),
  videoImage: z.boolean(),
  /** Repo-relative paths the change touched; the caller caps it at 50. */
  changed: z.array(z.string()).max(200).optional(),
  /** How many checks Verify ran (an API or CLI change is shown by their output). */
  checks: z.number().int().min(0).optional(),
});
export type EvidenceContext = z.infer<typeof EvidenceContext>;

/** What Ship's decisions read: a review event, a comment, a fix, or the facts of a finished task for the retro. */
export const ShipContext = z.object({
  kind: z.enum(["event", "comment", "fix", "retro"]),
  event: z
    .object({
      actor: z.string(),
      isBot: z.boolean(),
      isMe: z.boolean(),
      kind: z.enum(["comment", "review", "push", "ci"]),
      state: z.string().nullable().optional(),
      body: z.string().max(2000),
      url: z.string().nullable(),
      /** A red CI run: the failed job's name, and the last 4,000 characters of its log (both flattened by the machine; data). */
      job: z.string().max(200).optional(),
      log: z.string().max(4000).optional(),
    })
    .optional(),
  comment: z
    .object({
      thread: z.object({
        id: z.string(),
        path: z.string().nullable(),
        line: z.number().int().nullable(),
        comments: z.array(z.object({ author: z.string(), body: z.string().max(4000), at: z.string() })).max(50),
      }),
      pack: z.object({
        summary: z.string(),
        scenarios: z.array(z.object({ id: z.string().optional(), text: z.string(), result: z.string() })),
        howToVerify: z.string(),
      }),
      myReplies: z.number().int(),
      /** What the read step (`pr_reply`) made of the thread, each through `postable()`: a model's summary, data. */
      reading: z.object({ asks: z.string().max(300), proposedFix: z.string().max(600) }).optional(),
    })
    .optional(),
  fix: z
    .object({
      changed: z.array(z.string()).max(200),
      diffSummary: z.string().max(4000),
      scenarios: z.array(z.object({ text: z.string(), result: z.string() })),
      /** The scenarios the fix may have changed (named by the reader, or whose tagged test file the fix changed). */
      affected: z.array(z.object({ id: z.string(), text: z.string(), result: z.string() })).max(50).optional(),
      threadSummary: z.string(),
    })
    .optional(),
  retro: z
    .object({
      predicted: z.object({ size: z.string().nullable(), risk: z.string().nullable(), estLoc: z.number().int().nullable(), urgency: z.string().nullable().optional() }),
      actual: z.object({
        /** Times a person changed what the machine had made: the card's edits, a corrected escalation, a ship override. */
        overrides: z.number().int().optional(),
        reviewRounds: z.number().int().optional(),
        reviewThreads: z.number().int().optional(),
        costUsd: z.number().optional(),
        /** Files the Build Report declared outside the map. */
        declaredFiles: z.number().int().optional(),
        added: z.number().int(),
        removed: z.number().int(),
        retries: z.object({ verify: z.number().int(), e2e: z.number().int(), ci: z.number().int(), total: z.number().int() }),
        escalations: z.number().int(),
        format: z.string().nullable(),
        durationMin: z.number().int().nullable(),
      }),
      runs: z.number().int(),
      /** `<time> <event name or from->to state>`, 300 lines at most: names and states only, never a note or a reason. */
      timeline: z.array(z.string().max(200)).max(300).optional(),
      /** The fix rounds' summaries, flattened (20 at most). Data, not instructions. */
      reviewComments: z.array(z.string().max(200)).max(20).optional(),
    })
    .optional(),
});
export type ShipContext = z.infer<typeof ShipContext>;

/** What the jira_intake pack reads: the issue, as Jira gives it, plus where it would land. */
export const JiraIntakeContext = z.object({
  key: z.string(),
  url: z.string(),
  summary: z.string(),
  /** The description as markdown (converted from ADF by the adapter). */
  description: z.string(),
  issueType: z.string().nullable(),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  dueAt: z.string().nullable(),
  /** The issue's comments, oldest first, as `author: text`. */
  comments: z.array(z.string()),
  /** The repo the ticket would use, when known, so the agent can check the ask against the code. */
  repoPath: z.string().nullable(),
  /** triage_signals's first read, when intake ran it: a hint, not a verdict. */
  classification: TaskClassification.nullable().optional(),
});
export type JiraIntakeContext = z.infer<typeof JiraIntakeContext>;

/** What triage_signals reads: an issue as the notch or intake sends it. `source` says where it
 *  came from (`jira:HAR-12`, a GitHub URL), for the record. */
export const IssueContext = z.object({
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()).optional(),
  source: z.string().optional(),
  /** What the person answered at triage's questions so far, for the signals' next reading. */
  answers: z.array(z.object({ question: z.string().max(2000), answer: z.string().max(2000) })).max(20).optional(),
});
export type IssueContext = z.infer<typeof IssueContext>;

/** What triage reads of what Intake gathered: the project, the owners, who reported it, the history of its sources, its attachments as references, and the filer's hints.
 *  Every text is a stranger's: the machine flattens and caps it, and the prompt says it is data. */
export const IntakeContext = z.object({
  project: z.string().nullable(),
  owners: z.array(z.string()).max(20),
  reporter: z.object({ id: z.string(), channel: z.string().optional(), name: z.string().optional() }).nullable(),
  history: z.array(z.object({ author: z.string().nullable(), text: z.string() })).max(50),
  attachments: z.array(z.object({ name: z.string(), url: z.string(), mediaType: z.string().optional(), size: z.number().optional() })).max(20),
  hints: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
});
export type IntakeContext = z.infer<typeof IntakeContext>;

/** What intake_dedup reads: the new report and the shortlist's titles and summaries, flattened and capped by the machine. At most five slots. */
export const DedupContext = z.object({
  title: z.string().max(500),
  text: z.string().max(4000),
  candidates: z
    .array(z.object({ slot: z.number().int().min(1).max(5), kind: z.enum(["open", "closed", "backlog"]), title: z.string().max(500), summary: z.string().max(1000) }))
    .max(5),
});
export type DedupContext = z.infer<typeof DedupContext>;

/** What pr_link reads: the PR under review and up to ten candidates (open Jira tickets and open board cards, numbered by slot), flattened and capped by the machine. A stranger wrote all of it. */
export const PrLinkContext = z.object({
  pr: z.object({
    title: z.string().max(500),
    branch: z.string().max(300),
    /** An excerpt of the PR's description. */
    body: z.string().max(3000),
    /** The changed paths. */
    files: z.array(z.string().max(300)).max(40),
  }),
  candidates: z.array(z.object({ slot: z.number().int().min(1).max(10), kind: z.enum(["jira", "card"]), id: z.string().max(200), title: z.string().max(500), excerpt: z.string().max(1000) })).max(10),
});
export type PrLinkContext = z.infer<typeof PrLinkContext>;

/** What the Ticket Machine's decision packs read: one ticket, flattened and capped by the machine (a ticket is a stranger's words), with its enrichment. */
export const TicketContext = z.object({
  key: z.string().max(200),
  title: z.string().max(500),
  description: z.string().max(4000),
  type: z.string().max(120).nullable(),
  priority: z.string().max(120).nullable(),
  reporter: z.string().max(120).nullable(),
  /** Whether the reporter can be asked something: the tool named them. */
  reachable: z.boolean(),
  labels: z.array(z.string().max(120)).max(30),
  sprint: z.string().max(120).nullable(),
  dueAt: z.string().max(60).nullable(),
  comments: z.array(z.object({ author: z.string().max(120), text: z.string().max(500) })).max(10),
  linked: z.array(z.string().max(200)).max(20),
  epic: z.string().max(200).nullable(),
  recent: z.array(z.object({ key: z.string().max(200), title: z.string().max(300) })).max(10),
  files: z.array(z.string().max(300)).max(10),
  candidates: z.array(z.object({ slot: z.number().int().min(1).max(5), kind: z.enum(["open", "closed", "backlog"]), title: z.string().max(500), summary: z.string().max(1000) })).max(5),
  /** The assessment, for the packs that read it (ticket_recommend, ticket_reply). */
  assessment: z.object({ priority: z.string().max(10), size: z.string().max(10), blastRadius: z.string().max(10), costOfDelay: z.number(), costOfDoing: z.number(), score: z.number() }).nullable().optional(),
});
export type TicketContext = z.infer<typeof TicketContext>;

/** What the conversation packs read: a Slack thread as a stranger wrote it, flattened and capped by script (every text through `maskPii`), and the cards and backlog items its channel can see by slot. */
export const ConversationContext = z.object({
  /** The channel's name, no `#`. */
  channel: z.string().max(120),
  /** A private channel, a DM or a group DM: a decision record of it is never harvested. */
  private: z.boolean(),
  /** At most 20 lines of `author: text`, each text at most 500 characters. */
  thread: z.array(z.string().max(620)).max(20),
  latest: z.string().max(500),
  author: z.object({ profile: z.enum(["bot", "guest", "vip", "member"]), title: z.string().max(120).nullable() }),
  candidates: z.array(z.object({ slot: z.number().int().min(1).max(5), kind: z.enum(["open", "closed", "backlog"]), title: z.string().max(500), summary: z.string().max(1000) })).max(5),
  /** For `conversation_reply` only: what the machine knows beyond the thread, each field already masked, flattened and capped by script. */
  reply: z
    .object({
      /** The machine's own word for the relation (the `ConversationRelationType`). */
      relation: z.enum(["related_to_in_progress", "related_to_backlog", "new_candidate", "none"]),
      card: z.string().max(2000).nullable(),
      evidence: z.string().max(2000).nullable(),
      /** At most three excerpts of the claiming repository's docs. */
      docs: z.array(z.string().max(1500)).max(3),
      /** The last edits a person made to drafts of this channel: what the machine wrote, and what the person sent. */
      tone: z.array(z.object({ machine: z.string().max(1500), person: z.string().max(1500) })).max(5),
    })
    .optional(),
});
export type ConversationContext = z.infer<typeof ConversationContext>;

/** What eval_judge reads: one eval case, what a good answer must contain, and the answer under
 *  test. The JSON fields are text, as the evals runner serialised them (evals/run.ts). */
export const EvalJudgeContext = z.object({
  /** The pack whose answer is judged, and the case it answered. */
  pack: PackId,
  caseId: z.string(),
  /** The case's rubric in words: what a good answer does. */
  rubric: z.string(),
  /** What the pack under test was given: its task and context, as JSON. */
  input: z.string(),
  /** The case's deterministic checks, as JSON; the runner has already applied them. */
  checks: z.string(),
  /** The pack's structured answer, as JSON. */
  answer: z.string(),
});
export type EvalJudgeContext = z.infer<typeof EvalJudgeContext>;

/** One thing to change in the film: where (a time, a scene, an element), what, and how serious when the critic raised it. */
export const VideoFixCard = z.object({
  t: z.number().nullable(),
  scene: z.string().nullable(),
  element: z.string().nullable(),
  text: z.string(),
  priority: z.enum(["P0", "P1", "P2"]).optional(),
});
export type VideoFixCard = z.infer<typeof VideoFixCard>;

/** What the video packs read: the approved scenarios, what the browser run left, the target, the narration, and (for the critic and the fix) the film's own measurements and sheets. */
export const VideoContext = z.object({
  scenarios: z.array(TestCase),
  record: TriageRecord.nullable(),
  pack: z.object({ summary: z.string(), howToVerify: z.string(), risk: Risk.nullable() }),
  /** `steps.jsonl` lines from the browser run, capped at 400. */
  steps: z.array(z.string()).max(400),
  chapters: z.array(z.object({ title: z.string(), start: z.number() })),
  target: QaTarget.nullable(),
  /** The clip length of each narrated scene; present once the narration job ran. */
  narration: z.array(z.object({ id: z.string(), durationS: z.number() })).nullable(),
  timeline: z.unknown().nullable(),
  /** The measure job's report.json. */
  report: z.unknown().nullable(),
  transcript: z.string().nullable(),
  /** Contact sheets, as paths in the container (under /evidence). */
  sheets: z.array(z.string()),
  fixCards: z.array(VideoFixCard),
  /** `evidence.video_budget_s`: the film's length limit in seconds; absent reads as 240. */
  budgetS: z.number().int().positive().optional(),
});
export type VideoContext = z.infer<typeof VideoContext>;

/** Schema 2 adds `context.testCases`; schema 3 renames its `test` field to `approach`. */
/** Where the repo's code graph is in the stage container, and how current. */
export const GraphContext = z.object({
  path: z.string(),
  commit: z.string(),
  builtAt: z.string(),
  /** False when the graph was built from a commit older than the task's base commit. */
  fresh: z.boolean(),
});
export type GraphContext = z.infer<typeof GraphContext>;

export const StageInput = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  stage: z.string(),
  pack: PackId,
  /** The engine to run the pack on, one of its `engines.allowed`; absent means the pack's default. */
  engine: EngineId.optional(),
  /** The effort to run the pack at; absent means the pack's own. */
  effort: EffortId.optional(),
  attempt: z.number().int(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    criteria: z.array(z.string()),
    repoPath: z.string(),
    branch: z.string(),
    source: TaskSource.nullable(),
    /** What triage recorded about the ticket; absent or null before it ran. */
    record: TriageRecord.nullable().optional(),
    /** What triage_signals said about the ticket (every signal with its confidence); absent or null when intake did not run it. */
    classification: TaskClassification.nullable().optional(),
    /** The evidence pack of the task's change; absent or null before verifying made one. */
    evidence: EvidencePack.nullable().optional(),
  }),
  plan: z
    .object({
      brief: z.string(),
      criteria: z.array(z.string()),
      assumptions: z.array(z.string()),
      /** The slices the planner proposed, when it split the work. */
      slices: z.array(z.unknown()).optional(),
      /** How to undo the change, from the plan. */
      rollback: z.string().optional(),
      /** The code map the plan stage opened with; its files count as planned. */
      map: CodeMapAnswer.nullable().optional(),
      /** The risk the plan was approved at. */
      risk: PlanRisk.optional(),
    })
    .nullable(),
  decisions: z.array(
    z.object({
      at: z.string(),
      decision: z.string(),
      reason: z.string().nullable(),
      answers: z.record(z.string(), z.string()),
    }),
  ),
  /** The MCP tools the machine bridged for this run (RFC 0013): served as luna tools; each call goes through the checks mailbox. */
  bridge: z.array(BridgedTool).default([]),
  priorFindings: z.array(Finding),
  context: z.object({
    projectContext: z.string().nullable(),
    /** For design_spec: the card's design reference, composed by the machine (RFC 0013). */
    design: DesignContext.nullable().optional(),
    /** For implementing: whether it may hand a UI slice to the ui-designer, and why not (RFC 0013, phase 5). The machine's own composition. */
    delegation: z.object({ available: z.boolean(), reason: z.string().max(300).optional(), helper: z.object({ role: z.string(), engine: z.string() }).optional() }).optional(),
    /** For ui_design: the slice it builds, the implementer's message (data), the head it starts from, the files each side owns, and on attempt 2 the files that conflicted. The spec comes in `plan.designSpec`. The machine's own composition. */
    helper: z
      .object({
        slice: z.object({ id: z.number().int(), title: z.string(), touchpoints: z.array(z.string()), acceptance: z.array(z.string()) }),
        message: z.string().max(2000),
        base: z.string(),
        locks: z.object({ mine: z.array(z.string()), theirs: z.array(z.string()) }),
        attempt: z.union([z.literal(1), z.literal(2)]),
        conflict: z.object({ files: z.array(z.string()) }).optional(),
      })
      .optional(),
    /** For a11y_audit: the WCAG level the repo audits at; the machine's own value. */
    a11y: A11yContext.nullable().optional(),
    /** For design_parity: what the browser run captured for each cited frame, the plan it followed, and the approved spec. The machine's own composition. */
    parity: z.object({ plan: CapturePlan, captures: z.array(ParityCapture), spec: DesignSpec.nullable() }).optional(),
    /** For e2e: the captures the browser run is asked to take for the frames its scenarios cite (RFC 0013, phase 3), one `qa-capture` command each. The machine's own plan. */
    parityPlan: CapturePlan.optional(),
    /** What the token economy hands this run (RFC 0007): the loop guard's settings, the facts learned in this repository, the approved tool mask. Absent with `MACHINE_ECONOMY=off`. */
    economy: EconomyInput.optional(),
    /** For fact_propose: the repository's name, the digests of its last runs and the texts of the facts it holds. */
    propose: ProposeContext.nullable().optional(),
    /** For reviewing_memory: the learned facts the machine would let the retro promote, by id. Data, never instructions. */
    factCandidates: z.array(z.object({ id: z.string().max(40), text: z.string().max(240) })).max(10).optional(),
    /** The cases approved at the test check, for implementing and verifying. */
    testCases: z.array(z.union([TestCase, LegacyTestCase])).optional(),
    /** Build's tests step: the test each scenario got (its id and the test file), for the implementer to build against and never weaken. */
    scenarioTests: z.array(z.object({ scenario: z.string(), file: z.string() })).optional(),
    /** Build's regression sweep failed: each failing check's name and the tail of its output, flattened and capped (data, never instruction). */
    sweepFailures: z.array(z.object({ name: z.string(), tail: z.string() })).optional(),
    /** Where the task branch forked from the repo; verifying diffs against it. */
    baseCommit: z.string().nullable().optional(),
    /** verifying: how many approved scenarios are browser checks the e2e stage runs after Verify (left out of `testCases`). */
    browserScenarios: z.number().int().nonnegative().optional(),
    /** implementing: locked test files a person approved changing, after the implementer's test-change request named them. */
    unlockedTests: z.array(z.string()).optional(),
    /** implementing and verifying: the machine's fact that the approved plan touches only documentation (domain/docs-only.ts): no test is written for it. */
    docsOnly: z.boolean().optional(),
    /** verifying: the commit the machine itself made for the scenario tests (Build's tests step) and its files. They are the harness's, not the change the ticket asks for. */
    testsCommit: z.object({ sha: z.string().regex(/^[0-9a-f]{7,64}$/), files: z.array(z.string()) }).nullable().optional(),
    /** For ci_watch: what the host fetched, since the sandbox has no gh credential. */
    ci: CiContext.nullable().optional(),
    /** For reviewing_memory: the last implementing run's slice ledger. */
    ledger: Ledger.nullable().optional(),
    /** For reviewing_memory: one row per earlier stage run of this task. */
    runs: z.array(RunSummary).optional(),
    /** For e2e: where QA runs, from the repo's luna.yaml. Credentials are references, never values. */
    qaTargets: z.array(QaTarget).optional(),
    /** For reviewing (a PR task): the PR's diff and comments, fetched by the host. */
    review: ReviewContext.nullable().optional(),
    /** For addressing (a PR task): the unresolved threads, fetched by the host. */
    threads: ThreadsContext.nullable().optional(),
    /** For implementing and verifying: the repo's own checks from its luna.yaml; absent means detect them. */
    checks: z.array(CheckSpec).optional(),
    /** For slack_triage: the inbox batch; the task is synthetic and there is no worktree. */
    slack: SlackTriageContext.nullable().optional(),
    /** For the jira_intake pack: the issue to read before it becomes a ticket. */
    jira: JiraIntakeContext.nullable().optional(),
    /** For the triage_signals pack: the issue to label. */
    issue: IssueContext.nullable().optional(),
    /** For risk_score, coverage_check and plan_check: the plan to judge; for the plan stage's second rounds, what to fix. */
    plan: PlanContext.nullable().optional(),
    /** For red_check and scope_check: what to judge about the Build stage's work. */
    check: CheckContext.nullable().optional(),
    /** For evidence_format: the change's record, surface and browser run. */
    evidence: EvidenceContext.nullable().optional(),
    /** For Ship's decisions and pr_reply: the review event, comment, fix or retro facts. */
    ship: ShipContext.nullable().optional(),
    /** For size_estimate: the change as a record or ticket, the code map's files and the limits. */
    size: SizeContext.nullable().optional(),
    /** For split_check: the origin, the proposed children and the script's findings. */
    split: SplitContext.nullable().optional(),
    /** For intake_dedup: the new report and the shortlist to judge. */
    dedup: DedupContext.nullable().optional(),
    /** For pr_link: the PR under review and the candidates to judge. */
    prLink: PrLinkContext.nullable().optional(),
    /** For the Ticket Machine's decisions (ticket_validity): the ticket and its enrichment. */
    ticket: TicketContext.nullable().optional(),
    /** For the Conversation Machine's decisions (conversation_assess): the thread, its author and the candidates. */
    conversation: ConversationContext.nullable().optional(),
    /** For the video packs (script, fix, recording, critic): the scenarios, the target, the narration, the film's measurements. */
    video: VideoContext.nullable().optional(),
    /** For the eval_judge pack: the case, its expectation and the answer to grade. */
    eval: EvalJudgeContext.nullable().optional(),
    /** For chat_triage: the chat batch; the task is synthetic and there is no worktree. */
    chat: ChatTriageContext.nullable().optional(),
    /** For foreman: the question and the board snapshot; the task is synthetic and there is no worktree. */
    foreman: ForemanContext.nullable().optional(),
    /** For ticket_chat: the message, the talk so far, the notes and the draft; the task is synthetic and the checkout is read-only. */
    ticketChat: TicketChatContext.nullable().optional(),
    /** For change_exceptions: the merged PRs that missed a change-management control; the task is synthetic and there is no worktree. */
    exceptions: ChangeExceptionsContext.nullable().optional(),
    /** For compliance_review: the repo's regimes and its wiki's control pages; the diff is `review`. */
    compliance: ComplianceReviewContext.nullable().optional(),
    /** For access_review: the flags of one org's quarterly access review; the task is synthetic and there is no worktree. */
    access: AccessReviewContext.nullable().optional(),
    /** For breach_assess: the incident to assess; the task is synthetic and there is no worktree. */
    breach: BreachAssessContext.nullable().optional(),
    /** For capacity_check: the ranked work, the throughput and the engines' headroom; the task is synthetic and there is no worktree. */
    capacity: CapacityContext.nullable().optional(),
    /** For status_report: one week's facts; the task is synthetic and there is no worktree. */
    status: StatusReportContext.nullable().optional(),
    /** For postmortem: the resolved incident and its breach clocks; the task is synthetic and there is no worktree. */
    postmortem: PostmortemContext.nullable().optional(),
    /** For docs_drift: the repo, the change's files and the repo's doc files; the worktree is the change. */
    docsDrift: DocsDriftContext.nullable().optional(),
    /** For questionnaire: the customer questionnaire, the policy pages and the answer bank; the task is synthetic and there is no worktree. */
    questionnaire: QuestionnaireContext.nullable().optional(),
    /** For vuln_triage: one security alert and the company's policy; the task is synthetic and there is no worktree. */
    vulns: VulnTriageContext.nullable().optional(),
    /** For release_notes: the PRs merged since the last release; the task is synthetic and there is no worktree. */
    release: ReleaseNotesContext.nullable().optional(),
    /** For question_council: the open triage questions to settle from the code, the card and the answers so far. */
    questions: QuestionsContext.nullable().optional(),
    /** For verifying: the files the code graph says depend on what the change touched, to review first. */
    blastRadius: z.array(z.string()).optional(),
    /** For verifying: how much of the change's added lines the repo's lcov report saw run; absent without a report. */
    coverage: CoverageSummary.optional(),
    /** The repo's Graphify code graph, read-only at /graph; null or absent when it has none. */
    graph: GraphContext.nullable().optional(),
    /** For triage: what Intake gathered (project, owners, reporter, history, attachment references, hints). */
    intake: IntakeContext.nullable().optional(),
  }),
  limits: z.object({
    maxTurns: z.number().int(),
    timeoutMs: z.number().int(),
  }),
  env: z.record(z.string(), z.string()),
});
export type StageInput = z.infer<typeof StageInput>;

/** Schema 2 adds the `escalated` outcome; schema 3 adds the ledger and the session id. */
/** A run's record: its runtime, engine and pinned model, the SDK and its version, and the sha256
 *  fingerprint (apps/factory/src/core/fingerprint.ts). Two runs with one fingerprint gave the model the
 *  same template, role, skills, access, answer schema and rules. */
export const RunInfo = z.object({
  runtime: z.string(),
  engine: z.string(),
  modelId: z.string(),
  /** The effort the run ran at; absent on runs recorded before it was set per run. */
  effort: EffortId.optional(),
  sdk: z.object({ name: z.string(), version: z.string() }),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RunInfo = z.infer<typeof RunInfo>;

export const StageOutput = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  ok: z.boolean(),
  outcome: StageOutcome,
  summary: z.string(),
  /** The pack's structured output verbatim (triage criteria, test lists, verdicts). */
  answer: z.record(z.string(), z.unknown()).nullable().optional(),
  needsInput: z.array(NeedsInputItem).nullable(),
  requested: z.array(RequestedAction),
  findings: z.array(Finding),
  artifacts: z.array(StageArtifact),
  slices: z.object({ done: z.number().int(), total: z.number().int() }),
  commit: z.string().nullable(),
  usage: z.object({
    turns: z.number().int(),
    costUsd: z.number().nullable(),
    /** The runtime's own count (input and output); null or absent where it cannot report one. */
    tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), /** Input read from the cache: beside the count, never part of the budget. */ cached: z.number().int().nonnegative().optional(), /** The parts of `input` written to the cache, by lifetime, for pricing. */ cacheWrite5m: z.number().int().nonnegative().optional(), cacheWrite1h: z.number().int().nonnegative().optional() }).nullable().optional(),
    durationMs: z.number().int(),
    model: z.string(),
  }),
  /** The runner may pass the SDK's error object through verbatim. */
  error: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable(),
  rateLimited: z.boolean(),
  /** Epoch seconds, as the SDK reports them; older runners wrote a string. */
  resetsAt: z.union([z.number(), z.string()]).nullable(),
  /** Schema 3: the slice ledger the run left, so no host mount is needed to read it. */
  ledger: Ledger.nullable().optional(),
  /** Schema 3: the SDK session, resumable from the per-task session dir. */
  sessionId: z.string().nullable().optional(),
  /** What the run ran on and the fingerprint of everything that shaped the model's input besides
   *  the task's data (RFC 0003 §7). Null for a script pack, absent from an older runner. */
  run: RunInfo.nullable().optional(),
}).refine((output) => output.schema >= 2 || output.outcome !== "escalated", {
  message: "outcome escalated needs schema 2",
  path: ["outcome"],
});
export type StageOutput = z.infer<typeof StageOutput>;
