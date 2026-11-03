// The pack registry: one entry per agent stage. It is the single source of truth for what a
// stage runs as (which role, on which engines, with what access and which skills), how long it may
// run, and the shape of the answer it must give. The machine reads the limits from here; the
// factory runner reads everything else; the conformance test checks that every answer a pack
// may give is one the machine ingests.
import { z } from "zod";

import { type Access, type LunaTool, NO_ACCESS, access } from "./access.ts";
import type { EngineId } from "./engines.ts";
import type { Effort } from "./models.ts";
import { type QuestionSet, answerSchema } from "./questions.ts";
import { SlackCategory, SlackPriority } from "./slack.ts";
import { Finding, LunaConfig, PackId, TestCase, VerifyResult } from "./stage.ts";

/** The agent roles. A pack names one; the runner looks its definition up by this. */
export const AgentRole = z.enum([
  "setup-planner",
  "triage-planner",
  "test-designer",
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
  // Helpers a PR task's role dispatches through the Agent tool; never a pack's own role.
  "security-reviewer",
  "reply-drafter",
  "code-fixer",
]);
export type AgentRole = z.infer<typeof AgentRole>;

const MINUTE = 60_000;

/** A pack that runs on one engine only. */
const only = (engine: EngineId) => ({ default: engine, allowed: [engine] });

/** A question the stage could not settle alone. `recommended` is what it would pick. */
const Question = z.object({ question: z.string(), recommended: z.string().nullable() });

/** The ordered slices triage proposes; `touchpoints` are repo-relative paths. */
export const Slice = z.object({
  title: z.string(),
  est_loc: z.number().int(),
  touchpoints: z.array(z.string()),
  acceptance: z.array(z.string()),
});
export type Slice = z.infer<typeof Slice>;

/** The hard-outward action a stage may ask for; the board approves it. */
const Requested = z.object({ kind: z.enum(["publish"]), target: z.string(), payload: z.record(z.string(), z.unknown()) });

/** The setup pack's proposal: a luna.yaml as data, with the reasoning you read before approving. */
export const SetupAnswer = z.object({
  kind: z.enum(["proposal", "escalated"]),
  summary: z.string(),
  config: LunaConfig.optional(),
  /** What the agent could not settle from the tree, for you to check: one line each. */
  notes: z.array(z.string()).optional(),
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

export const TriageAnswer = z.object({
  kind: z.enum(["brief", "questions"]),
  summary: z.string(),
  criteria: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  slices: z.array(Slice).optional(),
  questions: z.array(Question).max(3).optional(),
  /** How sure triage is, and how risky the touched paths are; the timer approval reads both. */
  confidence: z.enum(["high", "medium", "low"]).optional(),
  risk: z.enum(["none", "low", "medium", "high"]).optional(),
});

export const TestDesignAnswer = z.object({
  kind: z.enum(["done", "questions"]),
  summary: z.string(),
  questions: z.array(Question).max(3).optional(),
  cases: z.array(TestCase).optional(),
});

export const ImplementingAnswer = z.object({
  kind: z.enum(["done", "test_change", "escalated"]),
  summary: z.string(),
  commit: z.string().nullable().optional(),
  slices: z.object({ done: z.number().int(), total: z.number().int() }).optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
  request: z.string().optional(),
});

export const VerifyingAnswer = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string(),
  findings: z.array(Finding),
  results: z.array(VerifyResult).optional(),
  kind: z.enum(["escalated"]).optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const E2eAnswer = z.object({
  verdict: z.enum(["pass", "fail", "partial", "skipped"]),
  summary: z.string(),
  kind: z.enum(["done", "escalated"]).optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
  criteria: z
    .array(z.object({ text: z.string(), result: z.enum(["pass", "fail", "partial"]), evidence: z.array(z.string()) }))
    .optional(),
});

export const EvidenceAnswer = z.object({ outcome: z.enum(["pass", "fail"]).optional() });

export const CiWatchAnswer = z.object({
  kind: z.enum(["done", "escalated"]).optional(),
  verdict: z.enum(["fixable", "flake", "infra", "needs_debug", "green"]),
  classification: z.enum(["test", "lint", "build", "flake", "infra", "drift", "none"]),
  summary: z.string(),
  runUrl: z.string().nullable().optional(),
  findings: z.array(Finding),
  requested: z.array(Requested).optional(),
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
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});

/** addressing (PR task): one commit per thread; the host posts each reply and resolves the threads marked. */
export const PrAddressAnswer = z.object({
  kind: z.enum(["done", "escalated"]),
  summary: z.string(),
  commit: z.string().nullable().optional(),
  replies: z.array(z.object({ threadId: z.string(), body: z.string(), resolve: z.boolean() })),
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
  /** Roles the pack's agent may dispatch as subagents (the SDK's Agent tool); each gets its own body, model and read-only tools. */
  helpers: AgentRole[];
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
  /** Below this confidence the answers are not acted on, and the caller takes the agent path. */
  minConfidence: number;
}

export type Pack = AgentPack | DecisionPack;

// Every agent pack carries skills: an explicit tool list hides them otherwise, and the role's skills
// (`luna-factory:<name>`) are only reachable through them. It also carries the luna `step`: every
// role reports progress with it, and the runner serves the luna tools to every agent pack.
const READ_ONLY: Partial<Access> = { read: true, skills: true, luna: ["step"], commands: ["cat", "ls", "head", "tail", "wc", "pwd", "echo", "git branch --show-current", "git rev-parse"] };
const CHECK_COMMANDS = ["npm", "pnpm", "yarn", "npx", "go", "cargo", "pip", "pytest", "make"];
const LEDGER_TOOLS: LunaTool[] = ["slice_init", "slice_set", "slice_list", "decision_get"];

/** What the setup planner may run to learn a repo: version prints and listings, nothing that builds. */
const PROBE_COMMANDS = ["which", "command -v", "find", "node", "npm", "pnpm", "yarn", "go", "cargo", "rustc", "python", "python3", "pip", "make", "docker", "git log", "git ls-files"];

/** What issue_classify asks about an issue before intake turns it into a ticket. */
const ISSUE_QUESTIONS: QuestionSet = {
  kind: {
    type: "choice",
    instructions: "What kind of work does this issue ask for?",
    criteria: {
      bug: "Something that works, or should work, is broken",
      feature: "New behaviour a user or the pipeline can see",
      chore: "Upkeep with no new behaviour: a refactor, dependencies, docs, CI",
      question: "It asks for an answer or a decision, not a change",
    },
  },
  area: {
    type: "choice",
    instructions: "Which part of the repository would the change touch most?",
    criteria: {
      board: "The Rust TUI under board/: views, keys, rendering",
      machine: "The Node service under machine/: tasks, stages, Postgres, the GitHub, Jira and Slack adapters",
      factory: "The stage runner under factory/: roles, prompts, skills and runtimes",
      contracts: "The shared types under contracts/: stage input and output, packs, engines",
      site: "The website under site/",
    },
  },
  ready: { type: "yesno", instructions: "Does the issue have testable acceptance criteria an agent could verify without asking anyone?" },
  size: {
    type: "score",
    instructions: "How much code would the change touch?",
    rubric: {
      tiny: "A line or two: a typo, a constant, a copy change",
      small: "One function or one file, with its test",
      medium: "Several files in one package",
      large: "Several packages, or a new subsystem",
    },
  },
};

/** The packs a decision model answers; every other pack is a role's or a script's. */
type DecisionPackId = "issue_classify";

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
    helpers: [],
    skills: ["writing-plans", "code-discovery"],
    access: access(READ_ONLY, { web: true, commands: ["gh issue view"], luna: ["decision_get"] }),
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
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
  implementing: {
    id: "implementing",
    kind: "agent",
    agent: "implementer",
    helpers: [],
    skills: ["tdd", "verification-before-completion", "code-discovery"],
    access: access(READ_ONLY, { write: true, luna: LEDGER_TOOLS, commands: ["git add", "git commit", "git diff", "git status", "git log", ...CHECK_COMMANDS] }),
    writable: true,
    maxTurns: 80,
    timeoutMs: 30 * MINUTE,
    engines: only("claude:sonnet"),
    effort: "medium",
    answer: ImplementingAnswer,
    template: "implementing.md",
  },
  verifying: {
    id: "verifying",
    kind: "agent",
    agent: "verifier",
    helpers: [],
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
  reviewing: {
    id: "reviewing",
    kind: "agent",
    agent: "pr-reviewer",
    // The security pass runs as a subagent when the diff touches a sensitive path.
    helpers: ["security-reviewer"],
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
    helpers: ["reply-drafter"],
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
  issue_classify: {
    id: "issue_classify",
    // Labels an issue on Jev: one call, no worktree, reached through POST /runs. Nothing in intake
    // calls it yet; a caller acts on answers above minConfidence and takes the agent path below.
    kind: "decision",
    questions: ISSUE_QUESTIONS,
    minConfidence: 0.7,
    writable: false,
    maxTurns: 1,
    timeoutMs: 1 * MINUTE,
    engines: only("jev"),
    answer: answerSchema(ISSUE_QUESTIONS),
  },
};

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
