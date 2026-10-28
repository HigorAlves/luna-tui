// The role definitions the SDK runs a stage as. The body of each role lives in
// factory/agents/<role>.md; the model, effort, tools, limits and skills come from the pack.
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRole, Pack } from "@hardness/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** How the plugin folder names its skills to the SDK: `<plugin name>:<skill>`. */
export const PLUGIN_NAME = "luna-factory";

export const ROLE_DESCRIPTION: Record<AgentRole, string> = {
  "setup-planner": "Reads a repository checkout and proposes its luna.yaml: the checks, the services the code needs, the toolchains and the policy; never writes.",
  "triage-planner": "Reads a ticket and the repo and turns it into a plan with testable criteria, assumptions and slices; asks at most three questions when no default exists.",
  "test-designer": "Designs the failing tests for an approved plan: one case per criterion, happy path, boundaries and error paths.",
  implementer: "Implements an approved plan slice by slice: red, green, one commit per slice, the suite green between.",
  verifier: "Reviews the change against the plan and the review contract, with a security pass; sets the verdict mechanically.",
  "qa-validator": "Drives the running app in a browser to prove each plan criterion and writes the evidence packet.",
  "ci-investigator": "Diagnoses a red CI run from its logs and classifies it: fixable, flake, infra, needs_debug or green.",
  "retro-reviewer": "Looks back at a finished task and proposes rules for the project context from incidents and patterns.",
  "pr-reviewer": "Reviews someone else's open pull request from its diff and returns line-anchored comments and a mechanical verdict; never posts, never edits.",
  "slack-triager": "Triages a batch of the person's Slack inbox items: priority, category, whether a reply is expected, a one-line summary and a draft; no tools, no worktree.",
  "jira-triager": "Reads one Jira issue and, read-only, the repo it would land in; decides ready, needs a brief or not for an agent, and writes the ticket's title, description and testable criteria.",
  "security-reviewer": "Reviews a diff for exploitable security issues and returns review-contract findings with a concrete exploit each; never edits.",
  "reply-drafter": "Drafts one short reply per review thread from the thread, the code and what changed; text only, never edits.",
  "code-fixer": "Applies a decided list of code changes to answer review threads, runs the project's checks and reports the diff.",
};

/** What a helper runs as when the pack's role dispatches it: read-only, its own model, its own skills. */
const HELPER: Partial<Record<AgentRole, Pick<AgentDefinition, "tools" | "model" | "skills" | "maxTurns">>> = {
  "security-reviewer": {
    tools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)"],
    model: "opus",
    skills: [`${PLUGIN_NAME}:review-contract`],
    maxTurns: 25,
  },
  "reply-drafter": {
    tools: ["Read", "Glob", "Grep"],
    model: "haiku",
    skills: [`${PLUGIN_NAME}:receiving-code-review`],
    maxTurns: 15,
  },
};

/** The definition a pack runs as, keyed by its role name, plus one per helper it may dispatch. */
export function agentDefinitions(pack: Pack, agentsDir: string): Record<string, AgentDefinition> {
  if (!pack.agent) return {};
  const body = (role: AgentRole) => readFileSync(join(agentsDir, `${role}.md`), "utf8");
  const helpers = Object.fromEntries(
    pack.helpers.map((role) => [
      role,
      { description: ROLE_DESCRIPTION[role], prompt: body(role), effort: pack.effort, ...(HELPER[role] ?? { tools: ["Read", "Glob", "Grep"] }) },
    ]),
  );
  const prompt = body(pack.agent);
  return {
    [pack.agent]: {
      description: ROLE_DESCRIPTION[pack.agent],
      prompt,
      // No `tools` here: the definition inherits the query's own list (the pack's). An explicit
      // list on the definition replaces the toolset and drops the SDK's StructuredOutput tool,
      // so the stage's JSON answer would arrive as text instead of `structured_output`.
      model: pack.model,
      effort: pack.effort,
      // No `maxTurns` either: the query's own limit is the slice-scaled budget the machine set.
      skills: pack.skills.map((skill) => `${PLUGIN_NAME}:${skill}`),
    },
    ...helpers,
  };
}
