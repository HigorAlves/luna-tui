// The stage contract between the machine and the factory runner: the machine writes
// `/in/stage.json` (StageInput) and reads `/out/result.json` (StageOutput). Both sides of
// the seam live in this repository; `factory-contract.test.ts` holds them together.
import { z } from "zod";

import { EngineBudgets, EngineId } from "./engines.ts";
import { ConfidencePolicySchema } from "./questions.ts";

/** What a stage run decided. Lives here, not in api.ts, so the two files do not import each other in a loop. */
export const StageOutcome = z.enum(["pass", "fail", "needs_input", "test_change", "escalated"]);
export type StageOutcome = z.infer<typeof StageOutcome>;

/** Where a task came from: a tracker issue, or an open PR acted on from the PR inbox. */
export const TaskSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repo: z.string(), number: z.number().int(), url: z.string() }),
  z.object({
    kind: z.literal("github_pr"),
    repo: z.string(),
    number: z.number().int(),
    url: z.string(),
    headRef: z.string(),
    baseRef: z.string(),
  }),
  /** A ticket made from a Slack message (`t` in the board's Slack inbox). */
  z.object({ kind: z.literal("slack"), channel: z.string(), ts: z.string(), permalink: z.string() }),
  /** A ticket imported from a Jira issue by intake. `issueType` is Jira's type name, e.g. `Bug`. */
  z.object({ kind: z.literal("jira"), key: z.string(), url: z.string(), issueType: z.string().nullable() }),
  /** A Luna Notch ticket run on the machine: `ref` is its board key (`LUNA-14`), `id` its uuid.
   *  The notch talks to Jira, Slack and Teams about it; `jiraKey` only names the branch. */
  z.object({ kind: z.literal("notch"), ref: z.string().min(1), id: z.string().min(1), jiraKey: z.string().nullable().optional() }),
]);
export type TaskSource = z.infer<typeof TaskSource>;

/** Which graph a task walks: `feature` is the full pipeline; the others are PR tasks. */
export const TaskRoute = z.enum(["feature", "setup", "ci_fix", "review", "address"]);
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
});
export type Finding = z.infer<typeof Finding>;

/** Pack ids equal the Hardness stage names they run. */
export const PackId = z.enum([
  "setup",
  "triage",
  "test_design",
  // The planner: runs in the test_design state (the machine's RUNS_IN), as the first half of the plan stage.
  "plan",
  "implementing",
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
  // Not a task stage: the replay evals' judge, grading another pack's answer to an eval case.
  "eval_judge",
  // Not a task stage: triages a batch of chat items (Slack or Teams) a client sends to POST /runs.
  "chat_triage",
]);
export type PackId = z.infer<typeof PackId>;

/** An engine per pack: a task's own overrides (`stages`), or a repo's luna.yaml `engines`. Each must
 *  be one of its pack's `engines.allowed`; the machine checks that against the pack registry. */
export const StageEngines = z.partialRecord(PackId, EngineId);
export type StageEngines = z.infer<typeof StageEngines>;

/** The ordered slices the planner proposes; `touchpoints` are repo-relative paths. */
export const Slice = z.object({
  title: z.string(),
  est_loc: z.number().int(),
  touchpoints: z.array(z.string()),
  acceptance: z.array(z.string()),
});
export type Slice = z.infer<typeof Slice>;

/** One behaviour test_design names: the plan criterion it proves, and how to prove it. */
export const TestCase = z.object({
  title: z.string(),
  criterion: z.string().nullable(),
  /** Free text: what to check, and the repo's own command when one applies. */
  approach: z.string(),
});
export type TestCase = z.infer<typeof TestCase>;

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

/** For reviewing (a PR task): what the host fetched about someone's PR. */
export const ReviewContext = z.object({
  pr: PrFacts,
  /** `gh pr diff` output, tail-capped by the host. */
  diff: z.string(),
  files: z.array(z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() })),
  existingComments: z.array(
    z.object({ path: z.string().nullable(), line: z.number().int().nullable(), author: z.string(), body: z.string() }),
  ),
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
      comments: z.array(z.object({ author: z.string(), body: z.string(), at: z.string() })),
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

/** One slice of the implementer's ledger, kept by the runner in `/out/ledger.json`. */
export const LedgerSlice = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(["pending", "red", "green", "committed", "escalated"]),
  commit: z.string().nullable(),
  estLoc: z.number().int().nullable().optional(),
  actualLoc: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
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
});
export type RunSummary = z.infer<typeof RunSummary>;

/** One of a repo's own checks, from its luna.yaml: a shell line run in `cwd` (the worktree
 *  root by default). With `paths`, it runs only for a change that touches one of them. */
export const CheckSpec = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  cwd: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
});
export type CheckSpec = z.infer<typeof CheckSpec>;

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
  policy: z
    .object({
      qa: z.enum(["web", "none"]).optional(),
      monthly_budget_usd: z.number().positive().optional(),
      auto_approve_plan_minutes: z.number().int().positive().optional(),
      max_concurrent: z.number().int().positive().optional(),
      holdout_cases: z.boolean().optional(),
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
  /** Monthly caps in USD on this repo's stage runs, by engine or credential (`openai:sol: 10`). */
  budget: z.object({ engines: EngineBudgets.optional() }).optional(),
});
export type LunaConfig = z.infer<typeof LunaConfig>;

/** A place the e2e stage may drive. `credential` is a reference (`env:NAME`), never a value. */
export const QaTarget = z.object({
  name: z.string(),
  baseUrl: z.string(),
  credential: z.string().nullable().optional(),
});
export type QaTarget = z.infer<typeof QaTarget>;

/** What triage_signals said about the issue a task came from, as intake stores it: each answer's
 *  pick (`size` is the rubric score, 0 tiny to 3 large), the lowest of the answers' confidences,
 *  when and on which model. A hint for people and for jira_intake; it decides nothing alone. */
export const TaskClassification = z.object({
  kind: z.string(),
  /** How sure Jev is of the kind alone; what routing reads. Absent on classifications stored before it. */
  kindConfidence: z.number().min(0).max(1).optional(),
  area: z.string(),
  ready: z.boolean(),
  size: z.number(),
  /** How soon (rubric score, 0 low to 3 urgent) and how risky (0 none to 3 high); absent on classifications stored before triage_signals asked. */
  urgency: z.number().optional(),
  risk: z.number().optional(),
  /** The archive suggestion and why (`none` when it should be worked). */
  archive: z.boolean().optional(),
  archiveReason: z.string().optional(),
  confidence: z.number().min(0).max(1),
  at: z.string(),
  model: z.string(),
  /** Every question's answer with its own confidence. */
  signals: z.record(z.string(), z.object({ answer: z.union([z.string(), z.number(), z.boolean(), z.null()]), confidence: z.number().min(0).max(1) })).optional(),
});
export type TaskClassification = z.infer<typeof TaskClassification>;

/** Why a task was archived instead of closed. */
export const ArchiveReason = z.enum(["duplicate", "sla_expired", "rejected", "not_for_agent", "pr_closed"]);
export type ArchiveReason = z.infer<typeof ArchiveReason>;

/** Why a stage stopped on purpose: `plan_wrong` the plan cannot be built as written (triage runs again),
 *  `env_broken` the sandbox or toolchain is, `flaky_tests` the tests do not hold still, `too_complex`
 *  the work is bigger than one stage, `undeclared_scope` it needs files or packages the plan did not name. */
export const EscalationReason = z.enum(["plan_wrong", "env_broken", "flaky_tests", "too_complex", "undeclared_scope", "other"]);
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
  qa: z.array(z.object({ question: z.string(), answer: z.string().nullable() })),
  decision: z.enum(["plan", "fast_lane", "conversation", "archive"]),
  reason: z.string(),
  at: z.string(),
  model: z.string(),
});
export type TriageRecord = z.infer<typeof TriageRecord>;

/** What the plan stage's decisions read, and what its second round hands the planner and the test
 *  designer: the record, the plan, the scenarios so far, the criteria no scenario names (`gaps`,
 *  computed from `cases[].criterion`) and which round this is. */
export const PlanContext = z.object({
  record: TriageRecord.nullable(),
  brief: z.string(),
  criteria: z.array(z.string()),
  assumptions: z.array(z.string()),
  slices: z.array(Slice),
  rollback: z.string().optional(),
  cases: z.array(TestCase).optional(),
  gaps: z.array(z.string()).optional(),
  round: z.number().int().optional(),
});
export type PlanContext = z.infer<typeof PlanContext>;

/** What shows a change does what the ticket asked, kept on the task for the person who approves it. */
export const EvidencePack = z.object({
  summary: z.string(),
  format: z.enum(["video", "captures", "text"]),
  scenarios: z.array(z.object({ text: z.string(), test: z.string().nullable(), result: z.enum(["pass", "fail", "partial", "skipped"]) })),
  findings: z.array(z.string()),
  /** Changes outside what the plan mapped. */
  outOfMap: z.array(z.string()),
  risk: Risk,
  rollback: z.string(),
  howToVerify: z.string(),
  commitSha: z.string(),
  media: z.array(z.object({ kind: z.enum(["video", "screenshot", "har", "report"]), label: z.string(), url: z.string() })),
  at: z.string(),
});
export type EvidencePack = z.infer<typeof EvidencePack>;

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
});
export type IssueContext = z.infer<typeof IssueContext>;

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

/** Schema 2 adds `context.testCases`; schema 3 renames its `test` field to `approach`. */
export const StageInput = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  stage: z.string(),
  pack: PackId,
  /** The engine to run the pack on, one of its `engines.allowed`; absent means the pack's default. */
  engine: EngineId.optional(),
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
      /** The slices triage proposed, when it split the work. */
      slices: z.array(z.unknown()).optional(),
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
  priorFindings: z.array(Finding),
  context: z.object({
    projectContext: z.string().nullable(),
    /** The cases approved at the test check, for implementing and verifying. */
    testCases: z.array(z.union([TestCase, LegacyTestCase])).optional(),
    /** Where the task branch forked from the repo; verifying diffs against it. */
    baseCommit: z.string().nullable().optional(),
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
    /** For the eval_judge pack: the case, its expectation and the answer to grade. */
    eval: EvalJudgeContext.nullable().optional(),
    /** For chat_triage: the chat batch; the task is synthetic and there is no worktree. */
    chat: ChatTriageContext.nullable().optional(),
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
 *  fingerprint (factory/src/core/fingerprint.ts). Two runs with one fingerprint gave the model the
 *  same template, role, skills, access, answer schema and rules. */
export const RunInfo = z.object({
  runtime: z.string(),
  engine: z.string(),
  modelId: z.string(),
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
