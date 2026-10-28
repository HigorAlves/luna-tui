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
};

/** The one definition a pack runs as, keyed by its role name. */
export function agentDefinitions(pack: Pack, agentsDir: string): Record<string, AgentDefinition> {
  if (!pack.agent) return {};
  const prompt = readFileSync(join(agentsDir, `${pack.agent}.md`), "utf8");
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
  };
}
