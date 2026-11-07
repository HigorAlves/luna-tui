// What a pack's agent may touch, in no runtime's words: each runtime maps it to its own tool
// names (the Claude runtime in factory/src/runtimes/claude/access.ts). See RFC 0002.

/** The luna tools: progress, the slice ledger, the settled decisions, the scope check and the board search (read-only). */
export type LunaTool = "step" | "slice_init" | "slice_set" | "slice_list" | "decision_get" | "scope_check" | "card_search" | "scenario_red" | "memory_recall";

export interface Access {
  /** Read files and search the tree. */
  read: boolean;
  /** Edit and create files. */
  write: boolean;
  /** Fetch a URL. */
  web: boolean;
  /** Dispatch the pack's helpers as subagents. */
  agent: boolean;
  /** Invoke the role's skills. */
  skills: boolean;
  /** The command prefixes the shell may run, such as `git add` or `npm`. */
  commands: string[];
  luna: LunaTool[];
}

export const NO_ACCESS: Access = { read: false, write: false, web: false, agent: false, skills: false, commands: [], luna: [] };

/** One access from fragments: a capability any fragment grants, each command and luna tool once. */
export function access(...parts: Partial<Access>[]): Access {
  return parts.reduce<Access>(
    (all, part) => ({
      read: all.read || !!part.read,
      write: all.write || !!part.write,
      web: all.web || !!part.web,
      agent: all.agent || !!part.agent,
      skills: all.skills || !!part.skills,
      commands: [...new Set([...all.commands, ...(part.commands ?? [])])],
      luna: [...new Set([...all.luna, ...(part.luna ?? [])])],
    }),
    NO_ACCESS,
  );
}

/** The commands that only read: all a read-only helper keeps of its parent's list. */
const READING_COMMANDS: ReadonlySet<string> = new Set(["cat", "ls", "head", "tail", "wc", "pwd", "echo", "git branch --show-current", "git rev-parse", "git diff", "git log", "git show", "git merge-base", "git rev-list", "git blame", "git status", "git ls-files", "gh pr view", "gh pr diff", "gh issue view", "graphify query", "graphify explain", "graphify path", "graphify affected", "graphify god-nodes"]);

/** `access` narrowed to reading: no writes, subagents, skills or luna tools, and only the
 *  commands that read. What a helper's child run gets of its parent's access. */
export function readOnly(a: Access): Access {
  return { ...a, write: false, agent: false, skills: false, commands: a.commands.filter((c) => READING_COMMANDS.has(c)), luna: [] };
}
