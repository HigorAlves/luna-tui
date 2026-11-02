// The role definitions the SDK runs a stage as. The description and body of each role live in
// factory/roles/<role>/role.md; the effort, tools, limits and skills come from the pack, the model
// from the engine it runs on.
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { type AgentRole, type EngineId, type Pack, resolveEngine } from "@hardness/contracts";

import { readRole } from "../../core/roles.ts";

/** How the plugin folder names its skills to the SDK: `<plugin name>:<skill>`. */
export const PLUGIN_NAME = "luna-factory";

type HelperSpec = Pick<AgentDefinition, "tools" | "skills" | "maxTurns"> & { engine: EngineId };

/** What a helper runs as when the pack's role dispatches it: read-only, its own engine, its own skills. */
const HELPER: Partial<Record<AgentRole, HelperSpec>> = {
  "security-reviewer": {
    tools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)"],
    engine: "claude:opus",
    skills: [`${PLUGIN_NAME}:review-contract`],
    maxTurns: 25,
  },
  "reply-drafter": {
    tools: ["Read", "Glob", "Grep"],
    engine: "claude:haiku",
    skills: [`${PLUGIN_NAME}:receiving-code-review`],
    maxTurns: 15,
  },
};

/** The definition a pack runs as on `modelId`, keyed by its role name, plus one per helper it may dispatch. */
export function agentDefinitions(pack: Pack, rolesDir: string, modelId: string): Record<string, AgentDefinition> {
  if (!pack.agent) return {};
  const helpers = Object.fromEntries(
    pack.helpers.map((role) => {
      const { description, body } = readRole(rolesDir, role);
      const { engine, ...helper }: Partial<HelperSpec> = HELPER[role] ?? { tools: ["Read", "Glob", "Grep"] };
      return [role, { description, prompt: body, effort: pack.effort, ...helper, ...(engine && { model: resolveEngine(engine).modelId }) }];
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
      effort: pack.effort,
      // No `maxTurns` either: the query's own limit is the slice-scaled budget the machine set.
      skills: pack.skills.map((skill) => `${PLUGIN_NAME}:${skill}`),
    },
    ...helpers,
  };
}
