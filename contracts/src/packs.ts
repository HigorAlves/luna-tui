// The pack registry: one entry per agent stage. It is the single source of truth for what a
// stage runs as (which role, on which engines, with what access and which skills), how long it may
// run, and the shape of the answer it must give. The machine reads the limits from here; the
// factory runner reads everything else; the conformance test checks that every answer a pack
// may give is one the machine ingests.
import { z } from "zod";

import { FACTORY_DEFAULTS } from "./config-v22.ts";
import { decisionEngines } from "./decision-defaults.ts";
import { type Access, type LunaTool, NO_ACCESS, access, readOnly } from "./access.ts";
import type { EngineId } from "./engines.ts";
import type { Effort } from "./models.ts";
import { AnswerScenario, AnswerStep } from "./plan.ts";
import { type DecisionPolicy, type QuestionSet, answerSchema, samePolicy } from "./questions.ts";
import { type Bands, type KnockOutFlags, type SubScores, type Weights, knockOut, riskProduct, scorePriority } from "./scoring.ts";
import { SlackCategory, SlackPriority } from "./slack.ts";
import { CodeMapAnswer, EscalationReason, Finding, LunaConfig, PackId, Risk, Slice, type TaskClassification, TestCase, VerifyResult } from "./stage.ts";

/** The agent roles. A pack names one; the runner looks its definition up by this. */
export const AgentRole = z.enum([
  "setup-planner",
  "triage-planner",
  "planner",
  "fast-planner",
  "test-designer",
  // Opens the plan stage: maps the goal onto the code graph.
  "code-mapper",
  "implementer",
  "verifier",
  "qa-validator",
  "ci-investigator",
  "retro-reviewer",
  "pr-reviewer",
  // The Slack inbox's triage: no tools, no worktree, a batch of messages in and verdicts out.
  "slack-triager",
  // Chat triage on demand: a Slack or Teams batch a client sends, verdicts out; no tools, no worktree.
  "chat-triager",
  // Jira intake: reads an issue (and, read-only, the repo) before it becomes a ticket.
  "jira-triager",
  // The replay evals' judge: grades another pack's answer against a case's rubric; no tools.
  "eval-judge",
  // Evidence's video pipeline: writes the script and timeline; drives the approved steps against the app; judges the finished film cold.
  "video-director",
  "demo-recorder",
  "video-critic",
  // Helpers a pack's role hands work to (packs' `helpers`); never a pack's own role.
  "security-reviewer",
  "reply-drafter",
  "code-fixer",
  "second-opinion",
]);
export type AgentRole = z.infer<typeof AgentRole>;

const MINUTE = 60_000;

/** A pack that runs on one engine only. */
const only = (engine: EngineId) => ({ default: engine, allowed: [engine] });

/** A question the stage could not settle alone. `recommended` is what it would pick. */
const Question = z.object({ question: z.string(), recommended: z.string().nullable() });

/** The hard-outward action a stage may ask for; the board approves it. */
const Requested = z.object({ kind: z.enum(["publish"]), target: z.string(), payload: z.record(z.string(), z.unknown()) });

/** The setup pack's proposal: a luna.yaml as data, with the reasoning you read before approving. */
export const SetupAnswer = z.object({
  kind: z.enum(["proposal", "escalated"]),
  summary: z.string(),
  config: LunaConfig.optional(),
  /** What the agent could not settle from the tree, for you to check: one line each. */
  notes: z.array(z.string()).optional(),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

/** The jira_intake pack's verdict on one issue. */
export const JiraIntakeAnswer = z.object({
  verdict: z.enum(["ready", "needs_brief", "not_for_agent"]),
  /** One line for the board and the Jira comment. */
  reason: z.string(),
  /** The ticket as it should read; set for `ready` only (the machine reads none of these for `needs_brief`). */
  title: z.string().optional(),
  description: z.string().optional(),
  criteria: z.array(z.string()).optional(),
  /** What is missing, for `needs_brief`: asked back on the issue as a comment, with the answer the agent would pick. */
  questions: z.array(Question).max(3).optional(),
});
export type JiraIntakeAnswer = z.infer<typeof JiraIntakeAnswer>;

/** Where a triaged ticket goes next: the plan stage, its fast lane, a reply, or the archive. */
export const TriageOutcome = z.enum(["plan", "fast_lane", "conversation", "archive"]);
export type TriageOutcome = z.infer<typeof TriageOutcome>;

/** What the triage agent may pick: the machine decides the fast lane from its rule, so it is not on offer (an old stored record with `fast_lane` still parses as a TriageOutcome). */
export const TriageAgentOutcome = z.enum(["plan", "conversation", "archive"]);

/** What triage writes of the ticket: the goal in one sentence and why it decided as it did, with an optional summary (at most
 *  120 words). The machine composes the rest of the record from its own facts. A draft written before wave 9 also carries the
 *  four grades; they still parse and are ignored. */
export const RecordDraft = z.object({
  goal: z.string(),
  reason: z.string(),
  summary: z.string().optional(),
  kind: z.string().optional(),
  size: z.string().optional(),
  urgency: z.string().optional(),
  risk: z.string().optional(),
});
export type RecordDraft = z.infer<typeof RecordDraft>;

export const TriageAnswer = z.object({
  kind: z.enum(["brief", "questions"]),
  summary: z.string(),
  /** Absent means `plan`. */
  outcome: TriageAgentOutcome.optional(),
  /** Required when `kind` is `brief`. */
  record: RecordDraft.optional(),
  /** The ticket's criteria, refined until testable. */
  criteria: z.array(z.string()).optional(),
  questions: z.array(Question).max(3).optional(),
  /** For `conversation`: the answer to post, drafted with reply-drafter. */
  reply: z.string().optional(),
  /** For `archive`. */
  archiveReason: z.enum(["duplicate", "out_of_scope", "stale", "not_actionable"]).optional(),
});

/** The planner's answer: the plan the one approval shows, built from triage's record. Every field but
 *  `kind` and `summary` is absent on `questions`. */
export const PlanAnswer = z.object({
  /** `needs_full_plan` is the fast planner's refusal: the ticket is bigger than triage read it; the stage plans again in full. */
  kind: z.enum(["done", "questions", "needs_full_plan"]),
  summary: z.string(),
  brief: z.string().optional(),
  /** Every record goal and ticket criterion, written to be testable. */
  criteria: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  slices: z.array(Slice).optional(),
  /** v2.2: the steps the plan prompts ask for, in place of `slices` (an answer with only slices still parses; the machine reads steps first). */
  steps: z.array(AnswerStep).optional(),
  /** A paragraph a person can follow to undo the change. */
  rollback: z.string().optional(),
  /** v2.2, asked for by the plan prompts. */
  outOfScope: z.array(z.string()).optional(),
  migration: z.string().optional(),
  flags: z.array(z.string()).optional(),
  questions: z.array(Question).max(3).optional(),
});
export type PlanAnswer = z.infer<typeof PlanAnswer>;

export const TestDesignAnswer = z.object({
  kind: z.enum(["done", "questions"]),
  summary: z.string(),
  questions: z.array(Question).max(3).optional(),
  /** v1: one case per behaviour, a title and an approach. Still accepted; the machine reads `scenarios` first. */
  cases: z.array(TestCase).optional(),
  /** v2.2: scenarios from the criteria and the goal, in given/when/then, each tied to its criterion by id. */
  scenarios: z.array(AnswerScenario).optional(),
});

export const ImplementingAnswer = z.object({
  kind: z.enum(["done", "test_change", "escalated"]),
  summary: z.string(),
  commit: z.string().nullable().optional(),
  slices: z.object({ done: z.number().int(), total: z.number().int() }).optional(),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
  request: z.string().optional(),
  /** What the change does, as scope_check saw it. */
  diffSummary: z.string().optional(),
  /** Files changed outside the plan's touchpoints, each with why. */
  outOfMap: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
});

export const VerifyingAnswer = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string(),
  findings: z.array(Finding),
  results: z.array(VerifyResult).optional(),
  kind: z.enum(["escalated"]).optional(),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const E2eAnswer = z.object({
  verdict: z.enum(["pass", "fail", "partial", "skipped"]),
  summary: z.string(),
  kind: z.enum(["done", "escalated"]).optional(),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
  criteria: z
    .array(z.object({ text: z.string(), criterion: z.string().nullable().optional(), result: z.enum(["pass", "fail", "partial"]), evidence: z.array(z.string()) }))
    .optional(),
});

export const EvidenceAnswer = z.object({ outcome: z.enum(["pass", "fail"]).optional() });

/** What the video director (video_script, video_fix) gives back: the script, the timeline (checked by the machine, not here), the facts it cites. */
export const VideoScriptAnswer = z.object({
  script: z.string(),
  timeline: z.unknown(),
  facts: z.array(z.object({ claim: z.string(), source: z.string() })),
  durationEstimateS: z.number(),
  kind: z.enum(["done", "escalated"]).optional(),
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const RecordingAnswer = z.object({
  timing: z.object({ marks: z.array(z.object({ scene: z.string(), t: z.number() })) }),
  recordingPath: z.string(),
  scenesRecorded: z.array(z.string()),
  kind: z.enum(["done", "escalated"]).optional(),
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const VideoScore = z.number().int().min(1).max(10);
export const VideoQaAnswer = z.object({
  message: z.string(),
  verdict: z.enum(["ship", "one_more_pass"]),
  scores: z.object({ hook: VideoScore, clarity: VideoScore, readability: VideoScore, motion: VideoScore, rhythm: VideoScore, composition: VideoScore, continuity: VideoScore, truth: VideoScore, sync: VideoScore }),
  defects: z.array(z.object({ priority: z.enum(["P0", "P1", "P2"]), t: z.number(), scene: z.string().nullable(), element: z.string().nullable(), symptom: z.string(), mechanism: z.string(), fix: z.string() })),
  weakestScene: z.string(),
});
export type VideoQaAnswer = z.infer<typeof VideoQaAnswer>;

export const CiWatchAnswer = z.object({
  kind: z.enum(["done", "escalated"]).optional(),
  verdict: z.enum(["fixable", "flake", "infra", "needs_debug", "green", "conflict_unresolvable"]),
  classification: z.enum(["test", "lint", "build", "flake", "infra", "drift", "conflict", "none"]),
  summary: z.string(),
  runUrl: z.string().nullable().optional(),
  findings: z.array(Finding),
  requested: z.array(Requested).optional(),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const ReviewingMemoryAnswer = z.object({
  summary: z.string(),
  incidents: z.array(z.string()),
  patterns: z.array(z.string()),
  proposedRules: z.array(z.object({ rule: z.string(), evidence: z.array(z.string()), scope: z.string() })),
  calibration: z.object({ estLocBias: z.number() }),
  rulesMarkdown: z.string().optional(),
  /** Where the task's size, risk, iterations, escalations or format differed from the prediction. */
  recalibration: z
    .array(z.object({ dimension: z.enum(["size", "risk", "iterations", "escalations", "format"]), predicted: z.string(), actual: z.string(), note: z.string() }))
    .optional(),
  /** Files the change touched that the plan's map did not name. */
  graphMisses: z.array(z.string()).optional(),
  /** A prompt a pack should change, and how, in one sentence. */
  promptUpdates: z.array(z.object({ pack: z.string(), change: z.string() })).optional(),
});

/** reviewing (PR task): a comment review the host posts at once; approve / request_changes wait for you. */
export const PrReviewAnswer = z.object({
  kind: z.enum(["done", "escalated"]).optional(),
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string(),
  findings: z.array(Finding),
  /** Line-anchored comments the host posts as one COMMENT review. */
  comments: z.array(
    z.object({ path: z.string(), line: z.number().int(), side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"), body: z.string() }),
  ),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

/** addressing (PR task): one commit per thread; the host posts each reply and resolves the threads marked. */
export const PrAddressAnswer = z.object({
  kind: z.enum(["done", "escalated"]),
  summary: z.string(),
  commit: z.string().nullable().optional(),
  replies: z.array(z.object({ threadId: z.string(), body: z.string(), resolve: z.boolean() })),
  /** Why it escalated, when `kind` is "escalated". */
  escalation: EscalationReason.optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

/** slack_triage: one verdict per inbox item id; the inbox ingests it, not the pipeline. */
export const SlackTriageAnswer = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      priority: SlackPriority,
      category: SlackCategory,
      /** The text asks the person for something nobody has answered yet. */
      expectsReply: z.boolean(),
      /** At most 90 characters: what they want from the person, not what they said. */
      summary: z.string().max(90),
      why: z.string(),
      /** Only when expectsReply: at most two sentences in the person's voice. */
      draft: z.string().nullable(),
      refs: z.array(z.object({ kind: z.enum(["pr", "issue", "jira", "url"]), ref: z.string() })),
      /** An ISO date the text names, else null. */
      deadline: z.string().nullable(),
    }),
  ),
});
export type SlackTriageAnswer = z.infer<typeof SlackTriageAnswer>;

/** eval_judge: how well one answer meets its case, after the schema and the deterministic checks. */
export const EvalJudgeAnswer = z.object({
  /** 0 is useless, 1 is what a careful senior engineer would have answered. */
  score: z.number().min(0).max(1),
  pass: z.boolean(),
  /** One line per point that moved the score, worst first. */
  reasons: z.array(z.string()),
});
export type EvalJudgeAnswer = z.infer<typeof EvalJudgeAnswer>;

/** chat_triage: the same verdicts as slack_triage, one per item id, for Slack and Teams alike. */
export const ChatTriageAnswer = SlackTriageAnswer;
export type ChatTriageAnswer = SlackTriageAnswer;

/** A role a pack's agent may hand work to, and the engine it runs on. On the agent's own runtime
 *  it is that runtime's subagent (Claude's Agent tool); otherwise the agent calls `delegate`
 *  (factory/src/core/delegate.ts), which runs it as a child of the stage: `helperPack`. */
export interface Helper {
  role: AgentRole;
  engine: EngineId;
}

/** What a helper run through `delegate` answers: its reply to the agent that asked, and findings
 *  per the review contract when it found problems in code. */
/** pr_reply: the draft of an answer to a reviewer's question on a shipped PR. */
export const PrReplyAnswer = z.object({ reply: z.string().max(1500), resolves: z.boolean(), confidence: z.number() });
export type PrReplyAnswer = z.infer<typeof PrReplyAnswer>;

export const HelperAnswer = z.object({ answer: z.string(), findings: z.array(Finding).optional() });
export type HelperAnswer = z.infer<typeof HelperAnswer>;

/** What a delegated helper's run as a whole may spend at most; the parent's remaining turns and time cap it further. */
export const HELPER_LIMITS = { maxTurns: 25, timeoutMs: 10 * MINUTE };

/** What every pack has, whatever runs it: the machine reads the limits, the runner the rest. */
interface PackBase {
  id: PackId;
  /** `agent`: a role works the stage from a prompt; `script`: no model; `decision`: typed questions to a decision model. */
  kind: "agent" | "decision" | "script";
  /** Whether the stage may edit the worktree and commit. */
  writable: boolean;
  maxTurns: number;
  timeoutMs: number;
  /** The engines the stage may run on; the machine picks one of `allowed`, else `default`. On a
   *  usage limit the machine runs the stage again on the first `fallback` engine (each one of
   *  `allowed`) that has not run it yet and whose credential is present and not at its limit. */
  engines: { default: EngineId; allowed: EngineId[]; fallback?: EngineId[] };
  /** The answer the stage must give; the runner turns it into the SDK's JSON schema. */
  answer: z.ZodType;
}

/** A pack a role runs from a prompt, or a script-only pack (`agent: null`) that calls no model. */
export interface AgentPack extends PackBase {
  kind: "agent" | "script";
  /** The role the stage runs as; null for a script-only pack that calls no model. */
  agent: AgentRole | null;
  /** Roles the pack's agent may hand work to, each on its own engine and read-only. */
  helpers: Helper[];
  /** Skills the role may invoke, by the name the plugin folder gives them. */
  skills: string[];
  /** What the agent may touch; each runtime turns it into its own tool list. */
  access: Access;
  /** How hard the role thinks: about the job, so it stays here whatever the engine. */
  effort: Effort;
  /** The prompt template under factory/prompts/. */
  template: string;
}

/** A pack that asks a decision model typed questions about its input: no role, tools or prompt. */
export interface DecisionPack extends PackBase {
  kind: "decision";
  questions: QuestionSet;
  /** Per question, the confidence at which an answer is acted on (`proceed`) and the one below which a person decides (`flag`). */
  policy: DecisionPolicy;
}

export type Pack = AgentPack | DecisionPack;

// Every agent pack carries skills: an explicit tool list hides them otherwise, and the role's skills
// (`luna-factory:<name>`) are only reachable through them. It also carries the luna `step`: every
// role reports progress with it, and the runner serves the luna tools to every agent pack.
const READ_ONLY: Partial<Access> = { read: true, skills: true, luna: ["step"], commands: ["cat", "ls", "head", "tail", "wc", "pwd", "echo", "git branch --show-current", "git rev-parse", "graphify query", "graphify explain", "graphify path", "graphify affected", "graphify god-nodes"] };
const CHECK_COMMANDS = ["npm", "pnpm", "yarn", "npx", "go", "cargo", "pip", "pytest", "make"];
const LEDGER_TOOLS: LunaTool[] = ["slice_init", "slice_set", "slice_list", "decision_get"];

/** What the setup planner may run to learn a repo: version prints and listings, nothing that builds. */
const PROBE_COMMANDS = ["which", "command -v", "find", "node", "npm", "pnpm", "yarn", "go", "cargo", "rustc", "python", "python3", "pip", "make", "docker", "git log", "git ls-files"];

/** What triage_signals asks about an issue (v2.2 panel 2): the kind, the type of work, a size on five levels, five urgency
 *  sub-scores that `scorePriority` turns into P0 to P3, a preliminary risk and the archive suggestion. One call, one schema.
 *  The goal reference is not asked: the machine reads it from the source. */
const TRIAGE_SIGNALS: QuestionSet = {
  kind: {
    type: "choice",
    instructions: "What kind of work does this issue ask for?",
    criteria: {
      bug: "Something that works, or should work, is broken",
      feature: "New behaviour a user or the pipeline can see",
      task: "A defined piece of work with no new behaviour to design: a migration, a rename, a config change",
      chore: "Upkeep with no new behaviour: a refactor, dependencies, docs, CI",
      question: "It asks for an answer or a decision, not a change",
      incident: "Production is down or wrong right now, data is lost, or a secret is exposed",
    },
  },
  type_of_work: {
    type: "choice",
    instructions: "Which kind of engineering would the change be?",
    criteria: {
      frontend: "Screens, views, keys, rendering, styling",
      backend: "Services, APIs, stages, persistence, adapters",
      infra: "Deploys, CI, containers, cloud or runtime configuration",
      data: "Schemas, migrations, backfills, pipelines, analytics",
      docs: "Documentation or copy only",
      mixed: "Two or more of the above in one change",
    },
  },
  ready: { type: "yesno", instructions: "Does the issue have testable acceptance criteria an agent could verify without asking anyone?" },
  size: {
    type: "choice",
    instructions: "How much code would the change touch?",
    criteria: {
      XS: "A line or two: a typo, a constant, a copy change",
      S: "One function or one file, with its test",
      M: "Several files in one package",
      L: "Several packages, or a new subsystem",
      XL: "A cross-cutting change that should be split before anyone builds it",
    },
  },
  who: { type: "score", instructions: "Who is affected?", rubric: { few: "One person, or an internal tool", team: "A team or one customer segment", everyone: "Every user, or the customers who pay" } },
  what: { type: "score", instructions: "What is at stake for them?", rubric: { rough_edge: "A rough edge: a workaround exists", broken: "A feature is broken or slow with no easy workaround", critical: "A core flow is down, or data or money is wrong" } },
  impact: { type: "score", instructions: "What does it cost the product or the business if it stays as it is?", rubric: { minor: "Little beyond annoyance", notable: "Support load, lost time, or a slipping commitment", major: "Revenue, a launch, a contract or trust" } },
  time: { type: "score", instructions: "How soon does it need to land?", rubric: { whenever: "No one is waiting", this_cycle: "This cycle", now: "Now: a deadline within days, or production is wrong" } },
  demand: { type: "score", instructions: "How many people are asking?", rubric: { one: "One person", few: "A few", many: "Many, or a customer escalation" } },
  risk_prelim: {
    type: "choice",
    instructions: "How much could the change break?",
    criteria: {
      low: "Isolated code with tests, docs or copy",
      medium: "Shared code other features depend on",
      high: "Auth, payments, data migrations, deletion, CI or infrastructure",
    },
  },
  archive: { type: "yesno", instructions: "Should this be archived instead of worked: a duplicate, out of scope, stale, or nothing an agent can act on?" },
  archive_reason: { type: "choice", instructions: "If it should be archived, why; else none.", criteria: { none: "It should be worked", duplicate: "Another open ticket asks for the same", out_of_scope: "Not this repository's or team's to do", stale: "Overtaken by events; nobody needs it now", not_actionable: "No change an agent could make or verify" } },
};

/** The bars of triage_signals, each question's from the diagram's confidence config and the flag band under it. */
function triagePolicy(config: typeof FACTORY_DEFAULTS.triage): DecisionPolicy {
  const bar = (proceed: number) => ({ proceed, flag: Math.round((proceed - config.flag_band) * 100) / 100 });
  const { kind, size, urgency, risk, archive } = config.confidence;
  return {
    kind: bar(kind), type_of_work: bar(urgency), ready: bar(urgency), size: bar(size),
    who: bar(urgency), what: bar(urgency), impact: bar(urgency), time: bar(urgency), demand: bar(urgency),
    risk_prelim: bar(risk), archive: bar(archive), archive_reason: bar(archive),
  };
}

/** What risk_score asks, before the plan, of the record and the code map: three scores that riskLevelOf multiplies, and the change's complexity. */
const RISK_QUESTIONS: QuestionSet = {
  blast_radius: { type: "score", instructions: "How much of the system does the change touch?", rubric: { one: "One module, its tests", some: "Several modules or a shared one", wide: "A subsystem, a contract others implement, or infrastructure" } },
  reversibility: { type: "score", instructions: "How easily is it undone?", rubric: { revert: "A revert restores everything", steps: "A revert plus a manual step", hard: "Data or external state changes that a revert does not undo" } },
  data_sensitivity: { type: "score", instructions: "What data does it handle?", rubric: { none: "No user or secret data", internal: "Internal records", sensitive: "Credentials, payments, personal data" } },
  complexity: { type: "choice", instructions: "How hard is the change to get right, apart from how far it reaches?", criteria: { S: "A few lines in one place", M: "A feature in one module", L: "Several modules, or a new mechanism", XL: "A redesign, or a change that needs a staged rollout" } },
};

/** The plan's risk from the three scores: each rounds to a level 1 to 3, and their product (riskProduct) is low up to 4, medium to 11, high from 12. */
const RISK_ORDER: Risk[] = ["none", "low", "medium", "high"];
/** The most severe of several risk grades: a decision may raise triage's grade, never lower it. */
export const maxRisk = (...levels: Risk[]): Risk => levels.reduce<Risk>((worst, level) => (RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(worst) ? level : worst), "none");

type RiskScores = { blast_radius: { score: number }; reversibility: { score: number }; data_sensitivity: { score: number } };
const levelOfScore = (answer: { score: number }): number => Math.round(answer.score) + 1;

/** The three scores of a risk_score answer as the diagram's levels and their product. */
export function riskOf(a: RiskScores): { product: number; level: Risk } {
  return riskProduct({ blastRadius: levelOfScore(a.blast_radius), reversibility: levelOfScore(a.reversibility), dataSensitivity: levelOfScore(a.data_sensitivity) });
}

export const riskLevelOf = (a: RiskScores): Risk => riskOf(a).level;

/** What coverage_check asks about the scenarios. The per-criterion gap list is not asked: coverageGaps computes it. */
const COVERAGE_QUESTIONS: QuestionSet = {
  pins: { type: "yesno", instructions: "Does each scenario pin the criterion it names: would it fail if that criterion were not met?" },
  redundancy: { type: "score", instructions: "How much do the scenarios overlap?", rubric: { none: "Each proves something the others do not", some: "A few restate another", heavy: "Most restate one check" } },
  untestable: { type: "yesno", instructions: "Is any criterion written so that no scenario could ever prove it?" },
};

/** The criteria no scenario names (exact match after trimming): what the test designer's next round is told to cover. */
export const coverageGaps = (criteria: string[], cases: { criterion: string | null }[]): string[] => criteria.filter((c) => !cases.some((k) => (k.criterion ?? "").trim() === c.trim()));

/** What plan_check asks about the plan against triage's record. */
const PLAN_CHECK_QUESTIONS: QuestionSet = {
  fits_record: { type: "score", instructions: "Does the plan build what the record's goal asks, no more, no less?", rubric: { no: "It builds something else or far more", partly: "It misses part of the goal or adds unasked work", yes: "It builds the goal" } },
  slices_cover_criteria: { type: "yesno", instructions: "Does every criterion appear in some slice's acceptance?" },
  rollback_stated: { type: "yesno", instructions: "Could a person follow the rollback paragraph at 2 a.m.?" },
  touchpoints_in_map: { type: "yesno", instructions: "Does every slice touch only files the code map names, or files it declares and explains? Answer yes when the plan has no code map." },
};

/** What red_check asks of a slice's failing test. */
const RED_CHECK_QUESTIONS: QuestionSet = {
  right_reason: { type: "yesno", instructions: "Does the output show the test failing because the behaviour is missing, not because of a typo, a missing import, a wrong path or a broken fixture?" },
  not_tautological: { type: "yesno", instructions: "Would this test still fail if the behaviour were absent: it asserts the behaviour, not its own setup?" },
};

/** What scope_check asks of the facts the machine computed over a change. */
const SCOPE_CHECK_QUESTIONS: QuestionSet = {
  planned_or_declared: { type: "yesno", instructions: "Is every changed file either planned (in the planned files) or declared with a reason that justifies it? The undeclared files are listed; any of them is a no." },
  no_new_dependency: { type: "yesno", instructions: "Does the change add no dependency, or only ones the plan or a declared reason calls for? The new dependencies are listed." },
  no_secret_or_pii: { type: "yesno", instructions: "Do the secret-looking additions contain no real secret or personal data? Answer yes when the list is empty or holds only obvious placeholders." },
  no_test_removed: { type: "yesno", instructions: "Does the change remove no test? The removed tests are listed; a test removed with the code it covered still counts as removed unless a declared reason explains it." },
  no_todo: { type: "yesno", instructions: "Does the change leave no TODO, FIXME or XXX that stands in for work the slice should have done? The added ones are listed." },
};

/** What finding_classify asks of one review finding and the code around it. */
const FINDING_CLASSIFY_QUESTIONS: QuestionSet = {
  severity: {
    type: "choice",
    instructions: "How severe is the review finding, judging it against its excerpt of the code? Read the finding's claim and the lines around it, not the reviewer's own severity label.",
    criteria: {
      blocker: "a bug or a security hole a reviewer would block the merge on",
      should_fix: "wrong or fragile, but mergeable with a follow-up",
      nit: "style, naming or a suggestion the author may ignore",
    },
  },
};

/** What e2e_failure_cause asks of a failed browser run. */
const E2E_FAILURE_QUESTIONS: QuestionSet = {
  cause: {
    type: "choice",
    instructions: "Why did the browser run fail? Judge from the summary and the rows that did not pass: did the app misbehave, was the scenario or its driving wrong, or did the environment fail before the scenario was really tried?",
    criteria: {
      product_bug: "the app does not do what the scenario asks",
      test_bug: "the scenario or the way it was driven is wrong; the app behaves as intended",
      env_flake: "the target, the dev server, the browser or a tool failed; the scenario was never really tried",
    },
  },
};

/** What evidence_format asks of a change and the browser run behind it. */
const EVIDENCE_FORMAT_QUESTIONS: QuestionSet = {
  format: {
    type: "choice",
    instructions: "Which format shows this change to the person who approves it? Judge from the record, the surface, what the browser run left (a recording or replayable steps) and whether the video image exists.",
    criteria: {
      video: "a user-visible change a person should watch happen: a web surface, scenarios the browser drove, a recording or replayable steps, and the video image is there",
      captures: "a user-visible change screenshots show well enough, or a recording is not possible",
      text: "no user-visible surface: an API, a library, docs, data, infrastructure",
    },
  },
};

/** What event_class asks of a review event on a shipped PR. */
const EVENT_CLASS_QUESTIONS: QuestionSet = {
  event: {
    type: "choice",
    instructions: "What is this event on the shipped PR? Judge from who did it, whether it is a bot, and what it says.",
    criteria: {
      comment: "a person's comment or review note that needs an answer or a change",
      approval: "a review that approves",
      changes_requested: "a review that asks for changes",
      push: "someone else pushed to the branch",
      noise: "a bot, a CI notice, a reaction, an edit of ours: nothing to do",
    },
  },
};

/** What comment_intent asks of a reviewer's comment. */
const COMMENT_INTENT_QUESTIONS: QuestionSet = {
  intent: {
    type: "choice",
    instructions: "What does this comment on the shipped PR want? Judge from the thread and what the pack says it did.",
    criteria: {
      question: "asks something the pack or the diff can answer",
      nit: "a small change nobody would block on",
      change_request: "asks for a change in behaviour or code",
      disagreement: "disputes the approach or the plan",
    },
  },
};

/** What fix_scope asks of a change request. */
const FIX_SCOPE_QUESTIONS: QuestionSet = {
  scope: {
    type: "choice",
    instructions: "How far does the change this thread asks for reach? Judge from the thread and the pack's scenarios.",
    criteria: {
      in_place: "a local change: fix, run the checks, push",
      re_verify_partial: "the change touches behaviour: fix and have the verifier review the delta",
      re_plan: "the plan itself is wrong: back to triage with the thread",
    },
  },
};

/** What evidence_valid asks after a fix on a shipped PR. */
const EVIDENCE_VALID_QUESTIONS: QuestionSet = {
  validity: {
    type: "choice",
    instructions: "After this fix, is the Evidence Pack still true? Judge from the files changed, the diff summary and the pack's scenarios.",
    criteria: {
      valid: "nothing a scenario shows changed",
      refresh_text: "the summary, the findings or how to verify changed",
      refresh_media: "a scenario's outcome or what is on screen changed",
    },
  },
};

/** What worth_learning asks of a finished task. */
const WORTH_LEARNING_QUESTIONS: QuestionSet = {
  worth: {
    type: "yesno",
    instructions: "Would a retro of this task teach the next one something: a surprise in size, risk, iterations, an escalation, a downgraded format, a repeated finding?",
  },
};

/** The packs a decision model answers; every other pack is a role's or a script's. */
type DecisionPackId = "triage_signals" | "risk_score" | "coverage_check" | "plan_check" | "red_check" | "scope_check" | "finding_classify" | "e2e_failure_cause" | "evidence_format" | "event_class" | "comment_intent" | "fix_scope" | "evidence_valid" | "worth_learning";

// The engines of a decision pack come from decision-defaults.ts: the file the scorecard writes, else Jev with a small Claude model behind it.

const planDecision = (id: "risk_score" | "coverage_check" | "plan_check" | "red_check" | "scope_check" | "finding_classify" | "e2e_failure_cause" | "evidence_format" | "event_class" | "comment_intent" | "fix_scope" | "evidence_valid" | "worth_learning", questions: QuestionSet): DecisionPack => ({
  id,
  kind: "decision",
  questions,
  policy: samePolicy(questions, { proceed: 0.7, flag: 0.5 }),
  writable: false,
  maxTurns: 1,
  timeoutMs: 1 * MINUTE,
  engines: decisionEngines(id),
  answer: answerSchema(questions),
});

export const PACKS: Record<Exclude<PackId, DecisionPackId>, AgentPack> & Record<DecisionPackId, DecisionPack> = {
  setup: {
    id: "setup",
    kind: "agent",
    agent: "setup-planner",
    helpers: [],
    skills: ["code-discovery"],
    // Read-only over the repo checkout itself (not a worktree), with network: it may fetch a
    // tool's docs. It proposes; the machine proves the checks and writes the file on approval.
    access: access(READ_ONLY, { web: true, commands: PROBE_COMMANDS }),
    writable: false,
    maxTurns: 40,
    timeoutMs: 15 * MINUTE,
    engines: only("claude:opus"),
    effort: "high",
    answer: SetupAnswer,
    template: "setup.md",
  },
  triage: {
    id: "triage",
    kind: "agent",
    agent: "triage-planner",
    helpers: [{ role: "reply-drafter", engine: "claude:haiku" }],
    skills: ["code-discovery"],
    access: access(READ_ONLY, { agent: true, web: true, commands: ["gh issue view"], luna: ["decision_get", "card_search"] }),
    writable: false,
    // One triage needs a record and an outcome, not a tour of the repo: the signals are read before it runs.
    maxTurns: 12,
    timeoutMs: 5 * MINUTE,
    // Codex is a candidate here; the machine keeps the Claude default until evals move it. A usage
    // limit on either moves the stage to the other.
    engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol"], fallback: ["codex:sol", "claude:opus"] },
    effort: "high",
    answer: TriageAnswer,
    template: "triage.md",
  },
  test_design: {
    id: "test_design",
    kind: "agent",
    agent: "test-designer",
    helpers: [],
    skills: ["tdd"],
    // Read-only: test_design designs the cases the implementer then writes as tests (the
    // approved cases reach implementing and verifying as `context.testCases`).
    access: access(READ_ONLY, { web: true, commands: ["gh issue view"], luna: ["decision_get"] }),
    writable: false,
    maxTurns: 40,
    timeoutMs: 15 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: TestDesignAnswer,
    template: "test_design.md",
  },
  plan: {
    id: "plan",
    kind: "agent",
    agent: "planner",
    helpers: [],
    skills: ["writing-plans", "code-discovery"],
    access: access(READ_ONLY, { web: true, commands: ["gh issue view"], luna: ["decision_get"] }),
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
    engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol"], fallback: ["codex:sol", "claude:opus"] },
    effort: "high",
    answer: PlanAnswer,
    template: "plan.md",
  },
  code_map: {
    id: "code_map",
    kind: "agent",
    agent: "code-mapper",
    helpers: [],
    skills: ["code-discovery"],
    // Reads the graph and the repo; git shortlog and log name the owners when there is no CODEOWNERS.
    access: access(READ_ONLY, { commands: ["git shortlog", "git log"] }),
    writable: false,
    maxTurns: 8,
    timeoutMs: 5 * MINUTE,
    engines: only("claude:haiku"),
    effort: "low",
    answer: CodeMapAnswer,
    template: "code_map.md",
  },
  plan_fast: {
    id: "plan_fast",
    kind: "agent",
    agent: "fast-planner",
    helpers: [],
    skills: ["writing-plans"],
    access: access(READ_ONLY, { web: true, commands: ["gh issue view"], luna: ["decision_get"] }),
    writable: false,
    maxTurns: 15,
    timeoutMs: 5 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "low",
    answer: PlanAnswer,
    template: "plan_fast.md",
  },
  test_design_fast: {
    id: "test_design_fast",
    kind: "agent",
    agent: "test-designer",
    helpers: [],
    skills: ["tdd"],
    access: access(READ_ONLY, { web: true, commands: ["gh issue view"], luna: ["decision_get"] }),
    writable: false,
    maxTurns: 15,
    timeoutMs: 5 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "low",
    answer: TestDesignAnswer,
    template: "test_design_fast.md",
  },
  implementing: {
    id: "implementing",
    kind: "agent",
    agent: "implementer",
    helpers: [],
    skills: ["tdd", "verification-before-completion", "code-discovery"],
    access: access(READ_ONLY, { write: true, luna: [...LEDGER_TOOLS, "scope_check"], commands: ["git add", "git commit", "git diff", "git status", "git log", ...CHECK_COMMANDS] }),
    writable: true,
    maxTurns: 80,
    timeoutMs: 30 * MINUTE,
    // Opus is allowed for the one shot after a too_complex escalation (`stronger`); Claude-only, so no fallback.
    engines: { default: "claude:sonnet", allowed: ["claude:sonnet", "claude:opus"] },
    effort: "medium",
    answer: ImplementingAnswer,
    template: "implementing.md",
  },
  verifying: {
    id: "verifying",
    kind: "agent",
    agent: "verifier",
    // A second opinion on another engine before the verdict: a child run through `delegate`.
    helpers: [{ role: "second-opinion", engine: "codex:sol" }],
    skills: ["review-contract", "caveman-review"],
    access: access(READ_ONLY, {
      write: true,
      luna: ["slice_list"],
      commands: ["gh pr view", "gh pr diff", "git diff", "git log", "git merge-base", "git rev-list", "git add", "git commit", ...CHECK_COMMANDS],
    }),
    writable: true,
    maxTurns: 60,
    timeoutMs: 20 * MINUTE,
    engines: only("claude:opus"),
    effort: "high",
    answer: VerifyingAnswer,
    template: "verifying.md",
  },
  e2e: {
    id: "e2e",
    kind: "agent",
    agent: "qa-validator",
    helpers: [],
    skills: ["browser-qa", "playwright-qa", "agent-browser", "qa-targets"],
    access: access(READ_ONLY, { write: true, commands: ["curl", "node", "npm", "pnpm", "npx", "agent-browser", "npx agent-browser", "command -v", "ffmpeg"] }),
    writable: true,
    maxTurns: 60,
    timeoutMs: 20 * MINUTE,
    engines: only("claude:sonnet"),
    // A 60-turn browser job: low effort drops steps and misreads screens; medium holds the thread.
    effort: "medium",
    answer: E2eAnswer,
    template: "e2e.md",
  },
  evidence: {
    id: "evidence",
    kind: "script",
    agent: null,
    helpers: [],
    skills: [],
    access: NO_ACCESS,
    writable: false,
    maxTurns: 0,
    timeoutMs: 5 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "low",
    answer: EvidenceAnswer,
    template: "evidence.md",
  },
  // Evidence's video pipeline. They run in the evidence state (the machine's RUNS_IN) and sit after `evidence` so the state still picks that one.
  video_script: {
    id: "video_script",
    kind: "agent",
    agent: "video-director",
    helpers: [],
    skills: ["video-script"],
    // It answers the script and the timeline; the machine writes them. No edit tool: nothing after Verify may change the worktree.
    access: access(READ_ONLY),
    writable: false,
    maxTurns: 25,
    timeoutMs: 10 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: VideoScriptAnswer,
    template: "video_script.md",
  },
  recording: {
    id: "recording",
    kind: "agent",
    agent: "demo-recorder",
    helpers: [],
    skills: ["demo-recording", "qa-targets", "playwright-qa"],
    access: access(READ_ONLY, { write: true, commands: ["node", "npx", "npx playwright", "ffmpeg", "curl", "command -v"] }),
    writable: true,
    maxTurns: 40,
    timeoutMs: 20 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: RecordingAnswer,
    template: "recording.md",
  },
  video_qa: {
    id: "video_qa",
    kind: "agent",
    agent: "video-critic",
    helpers: [],
    skills: ["video-critic"],
    // Reads the contact sheets under /evidence (mounted read-only) and the worktree.
    access: access(READ_ONLY),
    writable: false,
    maxTurns: 12,
    timeoutMs: 8 * MINUTE,
    // Another engine than the writer (sonnet). Only the Claude runtime is known to read images, so haiku is the default; codex:sol judges from the report, the transcript and the timeline.
    engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:sol"], fallback: ["codex:sol"] },
    effort: "medium",
    answer: VideoQaAnswer,
    template: "video_qa.md",
  },
  video_fix: {
    id: "video_fix",
    kind: "agent",
    agent: "video-director",
    helpers: [],
    skills: ["video-script"],
    // It answers the script and the timeline; the machine writes them. No edit tool: nothing after Verify may change the worktree.
    access: access(READ_ONLY),
    writable: false,
    maxTurns: 25,
    timeoutMs: 10 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: VideoScriptAnswer,
    template: "video_fix.md",
  },
  ci_watch: {
    id: "ci_watch",
    kind: "agent",
    agent: "ci-investigator",
    helpers: [],
    skills: ["ci-routing", "review-contract"],
    access: access(READ_ONLY, {
      commands: ["gh run", "gh workflow", "gh pr checks", "gh pr view", "git log", "git diff"],
      // The PR number comes from the settled decisions when the machine recorded one.
      luna: ["decision_get"],
    }),
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: CiWatchAnswer,
    template: "ci_watch.md",
  },
  reviewing_memory: {
    id: "reviewing_memory",
    kind: "agent",
    agent: "retro-reviewer",
    helpers: [],
    skills: [],
    access: access(READ_ONLY, { commands: ["git log", "git blame"], luna: ["slice_list"] }),
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
    engines: only("claude:opus"),
    effort: "high",
    answer: ReviewingMemoryAnswer,
    template: "reviewing_memory.md",
  },
  // Runs in the shipping state (the machine's RUNS_IN) and sits after reviewing_memory so the state still picks that one.
  pr_reply: {
    id: "pr_reply",
    kind: "agent",
    agent: "reply-drafter",
    helpers: [],
    skills: [],
    access: access(READ_ONLY),
    writable: false,
    maxTurns: 8,
    timeoutMs: 3 * MINUTE,
    engines: only("claude:haiku"),
    effort: "low",
    answer: PrReplyAnswer,
    template: "pr_reply.md",
  },
  reviewing: {
    id: "reviewing",
    kind: "agent",
    agent: "pr-reviewer",
    // The security pass runs as a subagent when the diff touches a sensitive path.
    helpers: [{ role: "security-reviewer", engine: "claude:opus" }],
    skills: ["review-contract", "caveman-review", "inline-review", "code-discovery"],
    access: access(READ_ONLY, { agent: true, commands: ["git diff", "git log", "git merge-base"] }),
    writable: false,
    maxTurns: 40,
    timeoutMs: 15 * MINUTE,
    engines: only("claude:opus"),
    effort: "high",
    answer: PrReviewAnswer,
    template: "reviewing.md",
  },
  addressing: {
    id: "addressing",
    kind: "agent",
    // The code fixer applies what each thread asks for; the reply drafter writes the thread replies.
    agent: "code-fixer",
    helpers: [{ role: "reply-drafter", engine: "claude:haiku" }],
    skills: ["receiving-code-review", "verification-before-completion", "tdd", "code-discovery"],
    access: access(READ_ONLY, { agent: true, write: true, luna: LEDGER_TOOLS, commands: ["git add", "git commit", "git diff", "git status", "git log", ...CHECK_COMMANDS] }),
    writable: true,
    maxTurns: 60,
    timeoutMs: 25 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: PrAddressAnswer,
    template: "addressing.md",
  },
  jira_intake: {
    id: "jira_intake",
    kind: "agent",
    // Reads one Jira issue before intake turns it into a ticket: ready, needs a brief, or not
    // for an agent; with the title, description and criteria the ticket should carry. It may
    // read the repo to check the ask against the code, nothing more.
    agent: "jira-triager",
    helpers: [],
    skills: [],
    access: access({ read: true }),
    writable: false,
    maxTurns: 8,
    timeoutMs: 5 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "low",
    answer: JiraIntakeAnswer,
    template: "jira_intake.md",
  },
  slack_triage: {
    id: "slack_triage",
    kind: "agent",
    // The Slack inbox's batch triage: not a task stage. No tools at all, no worktree; the
    // batch is in the input and the answer is the whole job. Haiku, low effort, three turns.
    agent: "slack-triager",
    helpers: [],
    skills: [],
    access: NO_ACCESS,
    writable: false,
    maxTurns: 3,
    timeoutMs: 3 * MINUTE,
    engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"], fallback: ["codex:luna", "claude:haiku"] },
    effort: "low",
    answer: SlackTriageAnswer,
    template: "slack_triage.md",
  },
  eval_judge: {
    id: "eval_judge",
    kind: "agent",
    // The replay evals' judge (evals/run.ts): not a task stage. One fixed engine, so scores
    // compare across the engines it judges; no tools and no worktree, the case is in the input.
    agent: "eval-judge",
    helpers: [],
    skills: [],
    access: NO_ACCESS,
    writable: false,
    maxTurns: 3,
    timeoutMs: 5 * MINUTE,
    engines: only("claude:opus"),
    effort: "medium",
    answer: EvalJudgeAnswer,
    template: "eval_judge.md",
  },
  chat_triage: {
    id: "chat_triage",
    kind: "agent",
    // Triage on demand (POST /runs): a client's Slack or Teams batch, the verdicts slack_triage
    // gives. Like slack_triage: no tools, no worktree, haiku, low effort, three turns.
    agent: "chat-triager",
    helpers: [],
    skills: [],
    access: NO_ACCESS,
    writable: false,
    maxTurns: 3,
    timeoutMs: 3 * MINUTE,
    engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"], fallback: ["codex:luna", "claude:haiku"] },
    effort: "low",
    answer: ChatTriageAnswer,
    template: "chat_triage.md",
  },
  triage_signals: {
    id: "triage_signals",
    // Labels an issue on Jev: one call, no worktree, reached through POST /runs. Nothing in intake
    // calls it yet; a caller acts on answers at or above `policy` and takes the agent path below.
    kind: "decision",
    questions: TRIAGE_SIGNALS,
    // Archiving a ticket by machine wants a higher bar than labelling it; a repo's luna.yaml `triage.confidence` and `policy.decisions` move these.
    policy: triagePolicy(FACTORY_DEFAULTS.triage),
    writable: false,
    maxTurns: 1,
    timeoutMs: 1 * MINUTE,
    // Jev by default; a small Claude or Codex model behind the same questions and schema when Jev
    // has no credential (RFC 0005 rule 1). Only calibration quality differs.
    engines: decisionEngines("triage_signals"),
    answer: answerSchema(TRIAGE_SIGNALS),
  },
  // The plan stage's decisions: each reads a plan context, one call, no worktree.
  risk_score: { ...planDecision("risk_score", RISK_QUESTIONS) },
  coverage_check: { ...planDecision("coverage_check", COVERAGE_QUESTIONS) },
  plan_check: { ...planDecision("plan_check", PLAN_CHECK_QUESTIONS) },
  // The Build stage's decisions: each reads a check context, one call, no worktree.
  red_check: { ...planDecision("red_check", RED_CHECK_QUESTIONS) },
  scope_check: { ...planDecision("scope_check", SCOPE_CHECK_QUESTIONS) },
  // Verify's decisions: each reads a check context, one call, no worktree.
  finding_classify: { ...planDecision("finding_classify", FINDING_CLASSIFY_QUESTIONS) },
  e2e_failure_cause: { ...planDecision("e2e_failure_cause", E2E_FAILURE_QUESTIONS) },
  // Evidence's decision: reads an evidence context, one call, no worktree.
  evidence_format: { ...planDecision("evidence_format", EVIDENCE_FORMAT_QUESTIONS) },
  // Ship's decisions: each reads a ship context, one call, no worktree.
  event_class: { ...planDecision("event_class", EVENT_CLASS_QUESTIONS) },
  comment_intent: { ...planDecision("comment_intent", COMMENT_INTENT_QUESTIONS) },
  fix_scope: { ...planDecision("fix_scope", FIX_SCOPE_QUESTIONS) },
  evidence_valid: { ...planDecision("evidence_valid", EVIDENCE_VALID_QUESTIONS) },
  worth_learning: { ...planDecision("worth_learning", WORTH_LEARNING_QUESTIONS) },
};

type Choice = { choice: string; confidence: number };
type Score = { score: number; confidence: number };
type YesNo = { value: boolean; p: number };
type IssueAnswerV1 = { kind: Choice; area: Choice; ready: YesNo; size: Score; urgency: Score; risk: Score; archive: YesNo; archive_reason: Choice };
type IssueAnswerV2 = { kind: Choice; type_of_work: Choice; ready: YesNo; size: Choice; who: Score; what: Score; impact: Score; time: Score; demand: Score; risk_prelim: Choice; archive: YesNo; archive_reason: Choice };

const SUB_SCORES = ["who", "what", "impact", "time", "demand"] as const;
const SIZE_BUCKETS = ["XS", "S", "M", "L", "XL"] as const;

/** What the machine adds to read a v2 answer: the repo's weights and bands, and the flags a source carries (a security label). */
export interface ClassifyOptions {
  weights?: Weights;
  bands?: Bands;
  flags?: KnockOutFlags;
}

const yn = (a: YesNo) => Math.max(a.p, 1 - a.p);

/** triage_signals's validated answer as a task keeps it: the picks, every answer's own confidence
 *  under `signals`, and the least sure answer's confidence (a yes/no's is its distance from a
 *  coin toss: max(p, 1 - p)). Reads both shapes: a stored v1 answer (`area`, one `urgency` score) and a v2 one,
 *  whose five sub-scores become a priority through `scorePriority` (a knock-out first: an incident or a flag is P0). */
export function classificationOf(answer: Record<string, unknown>, model: string, at: Date, options: ClassifyOptions = {}): TaskClassification {
  return "type_of_work" in answer ? classificationV2(answer as unknown as IssueAnswerV2, model, at, options) : classificationV1(answer as unknown as IssueAnswerV1, model, at);
}

function classificationV2(answer: IssueAnswerV2, model: string, at: Date, options: ClassifyOptions): TaskClassification {
  const { kind, type_of_work, ready, size, risk_prelim, archive, archive_reason } = answer;
  const confidences = [kind.confidence, type_of_work.confidence, yn(ready), size.confidence, ...SUB_SCORES.map((k) => answer[k].confidence), risk_prelim.confidence, yn(archive), archive_reason.confidence];
  // An answer's score runs 0 to 2 over the rubric; the scoring model's run 1 to 3.
  const subScores = Object.fromEntries(SUB_SCORES.map((k) => [k, answer[k].score + 1])) as SubScores;
  const scored = scorePriority(subScores, {
    ...(options.weights ? { weights: options.weights } : {}),
    ...(options.bands ? { bands: options.bands } : {}),
    confidences: Object.fromEntries(SUB_SCORES.map((k) => [k, answer[k].confidence])),
  });
  const knocked = knockOut({ ...options.flags, ...(kind.choice === "incident" ? { incident: true } : {}) });
  const signals: Record<string, { answer: string | number | boolean; confidence: number }> = {
    kind: { answer: kind.choice, confidence: kind.confidence },
    type_of_work: { answer: type_of_work.choice, confidence: type_of_work.confidence },
    ready: { answer: ready.value, confidence: yn(ready) },
    size: { answer: size.choice, confidence: size.confidence },
    ...Object.fromEntries(SUB_SCORES.map((k) => [k, { answer: answer[k].score, confidence: answer[k].confidence }])),
    risk_prelim: { answer: risk_prelim.choice, confidence: risk_prelim.confidence },
    archive: { answer: archive.value, confidence: yn(archive) },
    archive_reason: { answer: archive_reason.choice, confidence: archive_reason.confidence },
  };
  const bucket = SIZE_BUCKETS.find((b) => b === size.choice) ?? "M";
  return {
    kind: kind.choice, kindConfidence: kind.confidence, ready: ready.value, size: SIZE_BUCKETS.indexOf(bucket),
    typeOfWork: type_of_work.choice as NonNullable<TaskClassification["typeOfWork"]>, sizeBucket: bucket, subScores,
    priority: knocked?.action === "p0" ? "P0" : scored.priority, riskPrelim: risk_prelim.choice as NonNullable<TaskClassification["riskPrelim"]>,
    archive: archive.value, archiveReason: archive_reason.choice, confidence: Math.min(...confidences), at: at.toISOString(), model, signals,
  };
}

function classificationV1(answer: IssueAnswerV1, model: string, at: Date): TaskClassification {
  const { kind, area, ready, size, urgency, risk, archive, archive_reason } = answer;
  const confidence = Math.min(kind.confidence, area.confidence, yn(ready), size.confidence, urgency.confidence, risk.confidence, yn(archive), archive_reason.confidence);
  const signals = {
    kind: { answer: kind.choice, confidence: kind.confidence },
    area: { answer: area.choice, confidence: area.confidence },
    ready: { answer: ready.value, confidence: yn(ready) },
    size: { answer: size.score, confidence: size.confidence },
    urgency: { answer: urgency.score, confidence: urgency.confidence },
    risk: { answer: risk.score, confidence: risk.confidence },
    archive: { answer: archive.value, confidence: yn(archive) },
    archive_reason: { answer: archive_reason.choice, confidence: archive_reason.confidence },
  };
  return {
    kind: kind.choice, kindConfidence: kind.confidence, area: area.choice, ready: ready.value, size: size.score,
    urgency: urgency.score, risk: risk.score, archive: archive.value, archiveReason: archive_reason.choice,
    confidence, at: at.toISOString(), model, signals,
  };
}

// The labels a v1 answer's scores were read against, kept so a classification stored before v2 still reads in words.
const V1_SIZE = ["tiny", "small", "medium", "large"];
const V1_URGENCY = ["low", "normal", "high", "urgent"];
const V1_RISK = ["none", "low", "medium", "high"];
const levelOf = (labels: string[], score: number): string => labels[Math.min(labels.length - 1, Math.max(0, Math.round(score)))]!;

/** A classification in one line, for an issue comment, a log or a prompt:
 *  v1 `question · machine · not ready · size tiny · lowest confidence 0.85 (jev) · urgency normal · risk low`,
 *  v2 `bug · backend · ready · size S · P2 · risk low · lowest confidence 0.70 (claude:haiku)`,
 *  each with ` · archive? <reason>` when it suggests archiving. */
export function classificationLine(c: TaskClassification): string {
  const archive = c.archive ? ` · archive? ${c.archiveReason ?? "yes"}` : "";
  if (c.sizeBucket) {
    return `${c.kind} · ${c.typeOfWork ?? "mixed"} · ${c.ready ? "ready" : "not ready"} · size ${c.sizeBucket}${c.priority ? ` · ${c.priority}` : ""}${c.riskPrelim ? ` · risk ${c.riskPrelim}` : ""} · lowest confidence ${c.confidence.toFixed(2)} (${c.model})${archive}`;
  }
  const extra = [c.urgency !== undefined ? ` · urgency ${levelOf(V1_URGENCY, c.urgency)}` : "", c.risk !== undefined ? ` · risk ${levelOf(V1_RISK, c.risk)}` : "", archive].join("");
  return `${c.kind} · ${c.area ?? c.typeOfWork ?? "unknown"} · ${c.ready ? "ready" : "not ready"} · size ${levelOf(V1_SIZE, c.size)} · lowest confidence ${c.confidence.toFixed(2)} (${c.model})${extra}`;
}

/** A helper as the pack its child run is: the helper's role on its engine, the parent's access
 *  narrowed to reading, no helpers of its own (delegation has depth 1), no skills, the parent's
 *  effort, and the helper's reply as its answer. Its id stays the parent's: it has no pack of its own. */
export function helperPack(parent: AgentPack, helper: Helper): AgentPack {
  return {
    id: parent.id,
    kind: "agent",
    agent: helper.role,
    helpers: [],
    skills: [],
    access: readOnly(parent.access),
    writable: false,
    maxTurns: HELPER_LIMITS.maxTurns,
    timeoutMs: HELPER_LIMITS.timeoutMs,
    engines: only(helper.engine),
    effort: parent.effort,
    answer: HelperAnswer,
    template: "helper.md",
  };
}

/** The packs a role or a script runs: every pack but the decisions. */
export const AGENT_PACKS: AgentPack[] = Object.values(PACKS).filter((pack): pack is AgentPack => pack.kind !== "decision");

/** Turn and time limits, and whether the pack edits the worktree: the machine's view of a pack. */
export const PACK_LIMITS: Record<PackId, { maxTurns: number; timeoutMs: number; writable: boolean }> = Object.fromEntries(
  Object.values(PACKS).map((pack) => [pack.id, { maxTurns: pack.maxTurns, timeoutMs: pack.timeoutMs, writable: pack.writable }]),
) as Record<PackId, { maxTurns: number; timeoutMs: number; writable: boolean }>;

/** The JSON schema the SDK's structured output takes for a pack's answer. */
export function answerJsonSchema(pack: Pack): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(pack.answer, { target: "draft-2020-12" }) as Record<string, unknown>;
  return schema;
}
