// A pack's access as the Claude SDK's two tool lists: the Claude names for reading, writing, the
// web, subagents, skills, shell commands and the luna server. A golden test pins the result.
import type { Access } from "@hardness/contracts";

export function claudeTools(access: Access, workRoot = "/work"): { tools: string[]; allowedTools: string[] } {
  const allowedTools = [
    ...(access.read ? ["Read", "Glob", "Grep"] : []),
    ...(access.write ? ["Write", "Edit"] : []),
    ...(access.web ? ["WebFetch"] : []),
    ...(access.agent ? ["Agent"] : []),
    ...(access.skills ? ["Skill"] : []),
    ...access.luna.map((tool) => `mcp__luna__${tool}`),
    // Models write `git -C /work log` as often as `git log`; the same command, so the same rule. The guard (core/guards.ts)
    // drops a -C that names the worktree and refuses the rest.
    ...access.commands.flatMap((command) => [`Bash(${command}:*)`, ...(command.startsWith("git ") ? [`Bash(git -C ${workRoot} ${command.slice(4)}:*)`] : [])]),
  ];
  // `tools` takes bare names (a scoped rule such as `Bash(git add:*)` is not a name and would
  // drop Bash); the scoped rules go to `allowedTools`, which is what dontAsk consults.
  return { tools: toolNames(allowedTools), allowedTools };
}

/** The tool names behind an allow-list: `Bash(git add:*)` and `Bash(npm:*)` are one `Bash`. */
function toolNames(allowed: string[]): string[] {
  return [...new Set(allowed.map((t) => t.replace(/\(.*\)$/, "")))];
}
