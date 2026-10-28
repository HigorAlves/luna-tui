// The pack registry: one entry per agent stage. It is the single source of truth for what a
// stage runs as (which role, on which model, with which tools and skills), how long it may
// run, and the shape of the answer it must give. The machine reads the limits from here; the
// factory runner reads everything else; the conformance test checks that every answer a pack
// may give is one the machine ingests.
import { z } from "zod";

import { Finding, LunaConfig, PackId, TestCase, VerifyResult } from "./stage.ts";

/** The eight agent roles. A pack names one; the runner looks its definition up by this. */
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
]);
export type AgentRole = z.infer<typeof AgentRole>;

const MINUTE = 60_000;

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
  tests: z.array(z.string()).optional(),
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

export interface Pack {
  id: PackId;
  /** The role the stage runs as; null for a script-only pack that calls no model. */
  agent: AgentRole | null;
  /** Skills the role may invoke, by the name the plugin folder gives them. */
  skills: string[];
  /** The tool allow-list, verbatim for the SDK. */
  tools: string[];
  /** Whether the stage may edit the worktree and commit. */
  writable: boolean;
  maxTurns: number;
  timeoutMs: number;
  /** The model alias and effort the role runs on. */
  model: "opus" | "sonnet" | "haiku";
  effort: "low" | "medium" | "high";
  /** The answer the stage must give; the runner turns it into the SDK's JSON schema. */
  answer: z.ZodType;
  /** The prompt template under factory/prompts/. */
  template: string;
}

// Every agent pack carries Skill: an explicit `tools` list hides it otherwise, and the role's skills
// (`luna-factory:<name>`) are only reachable through it.
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Skill", ...["cat", "ls", "head", "tail", "wc", "pwd", "echo", "git branch --show-current", "git rev-parse"].map((c) => `Bash(${c}:*)`)];
const CHECK_COMMANDS = ["npm", "pnpm", "yarn", "npx", "go", "cargo", "pip", "pytest", "make"].map((c) => `Bash(${c}:*)`);
const LEDGER_TOOLS = ["mcp__luna__step", "mcp__luna__slice_init", "mcp__luna__slice_set", "mcp__luna__slice_list", "mcp__luna__decision_get"];

/** What the setup planner may run to learn a repo: version prints and listings, nothing that builds. */
const PROBE_COMMANDS = ["which", "command -v", "find", "node", "npm", "pnpm", "yarn", "go", "cargo", "rustc", "python", "python3", "pip", "make", "docker", "git log", "git ls-files"].map((c) => `Bash(${c}:*)`);

export const PACKS: Record<PackId, Pack> = {
  setup: {
    id: "setup",
    agent: "setup-planner",
    skills: ["code-discovery"],
    // Read-only over the repo checkout itself (not a worktree), with network: it may fetch a
    // tool's docs. It proposes; the machine proves the checks and writes the file on approval.
    tools: [...READ_ONLY_TOOLS, "WebFetch", ...PROBE_COMMANDS],
    writable: false,
    maxTurns: 40,
    timeoutMs: 15 * MINUTE,
    model: "opus",
    effort: "high",
    answer: SetupAnswer,
    template: "setup.md",
  },
  triage: {
    id: "triage",
    agent: "triage-planner",
    skills: ["writing-plans", "code-discovery"],
    tools: [...READ_ONLY_TOOLS, "WebFetch", "Bash(gh issue view:*)", "mcp__luna__decision_get"],
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
    model: "opus",
    effort: "high",
    answer: TriageAnswer,
    template: "triage.md",
  },
  test_design: {
    id: "test_design",
    agent: "test-designer",
    skills: ["tdd"],
    // Read-only: test_design designs the cases the implementer then writes as tests (the
    // approved cases reach implementing and verifying as `context.testCases`).
    tools: [...READ_ONLY_TOOLS, "WebFetch", "Bash(gh issue view:*)", "mcp__luna__decision_get"],
    writable: false,
    maxTurns: 40,
    timeoutMs: 15 * MINUTE,
    model: "sonnet",
    effort: "medium",
    answer: TestDesignAnswer,
    template: "test_design.md",
  },
  implementing: {
    id: "implementing",
    agent: "implementer",
    skills: ["tdd", "verification-before-completion", "code-discovery"],
    tools: [
      ...READ_ONLY_TOOLS,
      "Write",
      "Edit",
      ...LEDGER_TOOLS,
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      ...CHECK_COMMANDS,
    ],
    writable: true,
    maxTurns: 80,
    timeoutMs: 30 * MINUTE,
    model: "sonnet",
    effort: "medium",
    answer: ImplementingAnswer,
    template: "implementing.md",
  },
  verifying: {
    id: "verifying",
    agent: "verifier",
    skills: ["review-contract", "caveman-review"],
    tools: [
      ...READ_ONLY_TOOLS,
      "Write",
      "Edit",
      "mcp__luna__slice_list",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git merge-base:*)",
      "Bash(git rev-list:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      ...CHECK_COMMANDS,
    ],
    writable: true,
    maxTurns: 60,
    timeoutMs: 20 * MINUTE,
    model: "opus",
    effort: "high",
    answer: VerifyingAnswer,
    template: "verifying.md",
  },
  e2e: {
    id: "e2e",
    agent: "qa-validator",
    skills: ["browser-qa", "playwright-qa", "agent-browser", "qa-targets"],
    tools: [
      ...READ_ONLY_TOOLS,
      "Write",
      "Edit",
      "Bash(curl:*)",
      "Bash(node:*)",
      "Bash(npm:*)",
      "Bash(pnpm:*)",
      "Bash(npx:*)",
      "Bash(agent-browser:*)",
      "Bash(npx agent-browser:*)",
      "Bash(command -v:*)",
      "Bash(ffmpeg:*)",
    ],
    writable: true,
    maxTurns: 60,
    timeoutMs: 20 * MINUTE,
    model: "sonnet",
    effort: "low",
    answer: E2eAnswer,
    template: "e2e.md",
  },
  evidence: {
    id: "evidence",
    agent: null,
    skills: [],
    tools: [],
    writable: false,
    maxTurns: 0,
    timeoutMs: 5 * MINUTE,
    model: "sonnet",
    effort: "low",
    answer: EvidenceAnswer,
    template: "evidence.md",
  },
  ci_watch: {
    id: "ci_watch",
    agent: "ci-investigator",
    skills: ["ci-routing", "review-contract"],
    tools: [
      ...READ_ONLY_TOOLS,
      "Bash(gh run:*)",
      "Bash(gh workflow:*)",
      "Bash(gh pr checks:*)",
      "Bash(gh pr view:*)",
      "Bash(git log:*)",
      "Bash(git diff:*)",
    ],
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
    model: "sonnet",
    effort: "medium",
    answer: CiWatchAnswer,
    template: "ci_watch.md",
  },
  reviewing_memory: {
    id: "reviewing_memory",
    agent: "retro-reviewer",
    skills: [],
    tools: [...READ_ONLY_TOOLS, "Bash(git log:*)", "Bash(git blame:*)", "mcp__luna__slice_list"],
    writable: false,
    maxTurns: 30,
    timeoutMs: 10 * MINUTE,
    model: "opus",
    effort: "high",
    answer: ReviewingMemoryAnswer,
    template: "reviewing_memory.md",
  },
  reviewing: {
    id: "reviewing",
    agent: "pr-reviewer",
    skills: ["review-contract", "caveman-review", "code-discovery"],
    tools: [...READ_ONLY_TOOLS, "Bash(git diff:*)", "Bash(git log:*)", "Bash(git merge-base:*)"],
    writable: false,
    maxTurns: 40,
    timeoutMs: 15 * MINUTE,
    model: "opus",
    effort: "high",
    answer: PrReviewAnswer,
    template: "reviewing.md",
  },
  addressing: {
    id: "addressing",
    agent: "implementer",
    skills: ["tdd", "verification-before-completion", "code-discovery"],
    tools: [
      ...READ_ONLY_TOOLS,
      "Write",
      "Edit",
      ...LEDGER_TOOLS,
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      ...CHECK_COMMANDS,
    ],
    writable: true,
    maxTurns: 60,
    timeoutMs: 25 * MINUTE,
    model: "sonnet",
    effort: "medium",
    answer: PrAddressAnswer,
    template: "addressing.md",
  },
};

/** Turn and time limits, and whether the pack edits the worktree: the machine's view of a pack. */
export const PACK_LIMITS: Record<PackId, { maxTurns: number; timeoutMs: number; writable: boolean }> = Object.fromEntries(
  Object.values(PACKS).map((pack) => [pack.id, { maxTurns: pack.maxTurns, timeoutMs: pack.timeoutMs, writable: pack.writable }]),
) as Record<PackId, { maxTurns: number; timeoutMs: number; writable: boolean }>;

/** The JSON schema the SDK's structured output takes for a pack's answer. */
export function answerJsonSchema(pack: Pack): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(pack.answer, { target: "draft-2020-12" }) as Record<string, unknown>;
  return schema;
}
