// What a pack's agent may touch, in no runtime's words: each runtime maps it to its own tool
// names (the Claude runtime in factory/src/runtimes/claude/access.ts). See RFC 0002.

/** The luna tools: progress, the slice ledger and the settled decisions. */
export type LunaTool = "step" | "slice_init" | "slice_set" | "slice_list" | "decision_get";

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
