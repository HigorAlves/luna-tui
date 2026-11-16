// The role definitions the SDK runs a stage as. The description and body of each role live in
// factory/roles/<role>/role.md; the effort, tools, limits and skills come from the pack, the model
// from the engine it runs on.
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { type AgentPack, type AgentRole, type Effort, helpersOn, resolveEngine } from "@hardness/contracts";

import { readRole } from "../../core/roles.ts";

/** How the plugin folder names its skills to the SDK: `<plugin name>:<skill>`. */
export const PLUGIN_NAME = "luna-factory";

type HelperSpec = Pick<AgentDefinition, "tools" | "skills" | "maxTurns">;

/** What a subagent helper runs as when the pack's role dispatches it: read-only, its own skills;
 *  its engine is the pack's helper entry's. */
const HELPER: Partial<Record<AgentRole, HelperSpec>> = {
  "security-reviewer": {
    tools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)"],
    skills: [`${PLUGIN_NAME}:review-contract`],
    maxTurns: 25,
  },
  // One reviewer per regime of the compliance lead: read the diff and the code around it, nothing else.
  "soc2-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  "hipaa-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  "gdpr-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  "lgpd-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  "us-privacy-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  // The path-triggered reviewers: the changed files and the code around them, nothing else.
  "migration-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  "iac-reviewer": { tools: ["Read", "Glob", "Grep"], maxTurns: 20 },
  "reply-drafter": {
    tools: ["Read", "Glob", "Grep"],
    skills: [`${PLUGIN_NAME}:receiving-code-review`],
    maxTurns: 15,
  },
};

/** The helpers the SDK runs as subagents: the ones on a Claude engine. The rest are `delegate`'s. */
export const subagentHelpers = (pack: AgentPack) => helpersOn(pack, "claude").filter((h) => resolveEngine(h.engine).runtime === "claude");

/** The definition a pack runs as on `modelId`, keyed by its role name, plus one per helper it may dispatch. */
export function agentDefinitions(pack: AgentPack, rolesDir: string, modelId: string, effort: Effort = pack.effort): Record<string, AgentDefinition> {
  if (!pack.agent) return {};
  const helpers = Object.fromEntries(
    subagentHelpers(pack).map(({ role, engine }) => {
      const { description, body } = readRole(rolesDir, role);
      const helper: HelperSpec = HELPER[role] ?? { tools: ["Read", "Glob", "Grep"] };
      return [role, { description, prompt: body, effort, ...helper, model: resolveEngine(engine).modelId }];
    }),
  );
  const { description, body: prompt } = readRole(rolesDir, pack.agent);
  return {
    [pack.agent]: {
      description,
      prompt,
      // No `tools` here: the definition inherits the query's own list (the pack's). An explicit
      // list on the definition replaces the toolset and drops the SDK's StructuredOutput tool,
      // so the stage's JSON answer would arrive as text instead of `structured_output`.
      model: modelId,
      effort,
      // No `maxTurns` either: the query's own limit is the slice-scaled budget the machine set.
      skills: pack.skills.map((skill) => `${PLUGIN_NAME}:${skill}`),
    },
    ...helpers,
  };
}
