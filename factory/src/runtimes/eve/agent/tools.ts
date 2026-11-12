// The tools a compiled stage agent is given (compile.ts re-exports them from agent/tools/): a
// `bash` that runs one command as one process (exec.ts), eve's own read_file, write_file, glob,
// grep and web_fetch, all behind the core guards, and the luna tools, which run in the factory process
// (core/luna-tools.ts keeps the state finish() reads) and are reached over a loopback call to the
// runner. A tool here runs inside the eve server, never in the factory.
import type { AgentRole, LunaTool } from "@hardness/contracts";
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
import { approve, fileInput, refusal, searchInput } from "./guard.ts";
import { secrets } from "./secrets.ts";

const WORKSPACE = process.env.LUNA_EVE_WORKSPACE || "/work";
/** The run's scratch folder: HOME and TMPDIR for every command. */
const SCRATCH = process.env.LUNA_EVE_SCRATCH || "/nonexistent";

/** What runs a command's argv: exec.ts's runArgv, or the conformance fake's stand-in (fake.ts, wired in by compile.ts). */
export type Executor = (argv: string[], options: { cwd: string; env: Record<string, string>; signal?: AbortSignal }) => Promise<ExecResult>;

/** The `bash` tool over an executor. */
export function bashTool(exec: Executor = runArgv) {
  return defineTool({
    description: [
      "Run one command from this stage's allow-list in the worktree and return its exit code, stdout and stderr.",
      "This is not a shell: the command runs as one process. Quote an argument with spaces ('...' or \"...\"); there are no pipes, redirection, globs, variables, substitution, chaining or cd.",
    ].join("\n"),
    inputSchema: z.object({ command: z.string().describe("The command line, e.g. git log --oneline -20") }),
    approval: ({ toolInput }) => approve("exec", toolInput),
    execute: withEconomy("bash", async ({ command }, { abortSignal }) => {
      // The approval ran the same check; this one stands even if a call reaches execute without it.
      const refused = refusal("exec", { command });
      const parsed = splitArgv(command);
      if (refused !== null || "refused" in parsed) return { exitCode: 126, stdout: "", stderr: refused ?? "refused", truncated: false };
      const env = commandEnv(parsed.argv[0] as string, { home: SCRATCH, ghToken: secrets().ghToken });
      return await exec(parsed.argv, { cwd: WORKSPACE, env, signal: abortSignal });
    }),
  });
}
export const bash = bashTool();
export const read_file = defineTool({ ...readFile, execute: withEconomy("read_file", readFile.execute), approval: ({ toolInput }) => approve("read", fileInput(toolInput)) });
export const write_file = defineTool({ ...writeFile, execute: withEconomy("write_file", writeFile.execute), approval: ({ toolInput }) => approve("write", fileInput(toolInput)) });
export const glob = defineTool({ ...eveGlob, execute: withEconomy("glob", eveGlob.execute), approval: ({ toolInput }) => approve("read", searchInput(toolInput)) });
export const grep = defineTool({ ...eveGrep, execute: withEconomy("grep", eveGrep.execute), approval: ({ toolInput }) => approve("read", searchInput(toolInput)) });
export const web_fetch = defineTool({ ...webFetch, execute: withEconomy("web_fetch", webFetch.execute), approval: ({ toolInput }) => approve("fetch", toolInput) });

/** A luna tool: the call goes to the runner's bridge. */
export function lunaTool(name: LunaTool) {
  return defineTool({
    description: LUNA_TOOLS[name].description,
    inputSchema: z.object(LUNA_TOOLS[name].input),
    execute: (input) => bridge(name, input),
  });
}

/** `delegate` (core/delegate.ts), over the bridge: a helper that gave no answer fails the call. */
export function delegateTool(description: string, roles: [AgentRole, ...AgentRole[]]) {
  return defineTool({
    description,
    inputSchema: z.object({ helper: z.enum(roles).describe("The helper's role"), message: z.string().min(1).describe("Everything the helper needs: what to look at and what to answer") }),
    async execute(input) {
      const value = await bridge("delegate", input);
      if (typeof value === "object" && value !== null && "error" in value) throw new Error(String(value.error));
      return value;
    },
  });
}
