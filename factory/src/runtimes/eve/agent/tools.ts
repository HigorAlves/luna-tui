// The tools a compiled stage agent is given (compile.ts re-exports them from agent/tools/): a
// `bash` that runs one command as one process (exec.ts), eve's own read_file, write_file, glob,
// grep and web_fetch, all behind the core guards, and the luna tools, which run in the factory process
// (core/luna-tools.ts keeps the state finish() reads) and are reached over a loopback call to the
// runner. A tool here runs inside the eve server, never in the factory.
import type { LunaTool } from "@hardness/contracts";
import { defineTool } from "eve/tools";
import { glob as eveGlob } from "eve/tools/glob";
import { grep as eveGrep } from "eve/tools/grep";
import { readFile } from "eve/tools/read_file";
import { webFetch } from "eve/tools/web_fetch";
import { writeFile } from "eve/tools/write_file";
import { z } from "zod";

import { splitArgv } from "../../../core/argv.ts";
import { LUNA_TOOLS } from "../../../core/luna-tools.ts";
import { type ExecResult, commandEnv, runArgv } from "../exec.ts";
import { bridge } from "./bridge.ts";
import { withEconomy } from "./economy.ts";
import { type Narrowing, approve, fileInput, refusal, searchInput } from "./guard.ts";
import { secrets } from "./secrets.ts";

const WORKSPACE = process.env.LUNA_EVE_WORKSPACE || "/work";
/** The run's scratch folder: HOME and TMPDIR for every command. */
const SCRATCH = process.env.LUNA_EVE_SCRATCH || "/nonexistent";

/** What runs a command's argv: exec.ts's runArgv, or the conformance fake's stand-in (fake.ts, wired in by compile.ts). */
export type Executor = (argv: string[], options: { cwd: string; env: Record<string, string>; signal?: AbortSignal }) => Promise<ExecResult>;

/** The guarded tools over an executor, approved against the stage's policy or, for a native subagent, that policy narrowed
 *  to its own. A subagent's calls are not the stage's economy: like a delegated helper, it runs outside the parent's guard envelope. */
function guarded(narrow?: Narrowing, exec: Executor = runArgv) {
  const observed: typeof withEconomy = narrow ? (_tool, execute) => execute : withEconomy;
  return {
    bash: defineTool({
      description: [
        "Run one command from this stage's allow-list in the worktree and return its exit code, stdout and stderr.",
        "This is not a shell: the command runs as one process. Quote an argument with spaces ('...' or \"...\"); there are no pipes, redirection, globs, variables, substitution, chaining or cd.",
      ].join("\n"),
      inputSchema: z.object({ command: z.string().describe("The command line, e.g. git log --oneline -20") }),
      approval: ({ toolInput }) => approve("exec", toolInput, narrow),
      execute: observed("bash", async ({ command }, { abortSignal }) => {
        // The approval ran the same check; this one stands even if a call reaches execute without it.
        const refused = refusal("exec", { command }, narrow);
        const parsed = splitArgv(command);
        if (refused !== null || "refused" in parsed) return { exitCode: 126, stdout: "", stderr: refused ?? "refused", truncated: false };
        const env = commandEnv(parsed.argv[0] as string, { home: SCRATCH, ghToken: secrets().ghToken });
        return await exec(parsed.argv, { cwd: WORKSPACE, env, signal: abortSignal });
      }),
    }),
    read_file: defineTool({ ...readFile, execute: observed("read_file", readFile.execute), approval: ({ toolInput }) => approve("read", fileInput(toolInput), narrow) }),
    write_file: defineTool({ ...writeFile, execute: observed("write_file", writeFile.execute), approval: ({ toolInput }) => approve("write", fileInput(toolInput), narrow) }),
    glob: defineTool({ ...eveGlob, execute: observed("glob", eveGlob.execute), approval: ({ toolInput }) => approve("read", searchInput(toolInput), narrow) }),
    grep: defineTool({ ...eveGrep, execute: observed("grep", eveGrep.execute), approval: ({ toolInput }) => approve("read", searchInput(toolInput), narrow) }),
    web_fetch: defineTool({ ...webFetch, execute: observed("web_fetch", webFetch.execute), approval: ({ toolInput }) => approve("fetch", toolInput, narrow) }),
  };
}

/** The `bash` tool over an executor. */
export const bashTool = (exec: Executor = runArgv) => guarded(undefined, exec).bash;

export const { bash, read_file, write_file, glob, grep, web_fetch } = guarded();

/** A native subagent's guarded tools: its child run is read-only and runs only `commands`, whatever the stage may. */
export const readOnlyTools = (commands: string[], exec: Executor = runArgv) => guarded({ writable: false, commands }, exec);

/** A luna tool: the call goes to the runner's bridge. */
export function lunaTool(name: LunaTool) {
  return defineTool({
    description: LUNA_TOOLS[name].description,
    inputSchema: z.object(LUNA_TOOLS[name].input),
    execute: (input) => bridge(name, input),
  });
}
