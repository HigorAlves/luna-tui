// The tools a compiled stage agent is given (compile.ts re-exports them from agent/tools/): a
// `bash` that runs one command as one process (exec.ts), eve's own read_file, write_file, glob,
// grep and web_fetch, all behind the core guards, and the luna tools, which run in the factory process
// (core/luna-tools.ts keeps the state finish() reads) and are reached over a loopback call to the
// runner. A tool here runs inside the eve server, never in the factory.
import type { LunaTool } from "@hardness/contracts";
import { request } from "node:http";
import { defineTool } from "eve/tools";
import { glob as eveGlob } from "eve/tools/glob";
import { grep as eveGrep } from "eve/tools/grep";
import { readFile } from "eve/tools/read_file";
import { webFetch } from "eve/tools/web_fetch";
import { writeFile } from "eve/tools/write_file";
import { z } from "zod";

import { splitArgv } from "../../../core/argv.ts";
import { LUNA_TOOLS } from "../../../core/luna-tools.ts";
import { commandEnv, runArgv } from "../exec.ts";
import { type Narrowing, approve, fileInput, refusal, searchInput } from "./guard.ts";
import { secrets } from "./secrets.ts";

const WORKSPACE = process.env.LUNA_EVE_WORKSPACE || "/work";
/** The run's scratch folder: HOME and TMPDIR for every command. */
const SCRATCH = process.env.LUNA_EVE_SCRATCH || "/nonexistent";

/** The guarded tools, approved against the stage's policy or, for a native subagent, that policy narrowed to its own. */
function guarded(narrow?: Narrowing) {
  return {
    bash: defineTool({
      description: [
        "Run one command from this stage's allow-list in the worktree and return its exit code, stdout and stderr.",
        "This is not a shell: the command runs as one process. Quote an argument with spaces ('...' or \"...\"); there are no pipes, redirection, globs, variables, substitution, chaining or cd.",
      ].join("\n"),
      inputSchema: z.object({ command: z.string().describe("The command line, e.g. git log --oneline -20") }),
      approval: ({ toolInput }) => approve("exec", toolInput, narrow),
      async execute({ command }, { abortSignal }) {
        // The approval ran the same check; this one stands even if a call reaches execute without it.
        const refused = refusal("exec", { command }, narrow);
        const parsed = splitArgv(command);
        if (refused !== null || "refused" in parsed) return { exitCode: 126, stdout: "", stderr: refused ?? "refused", truncated: false };
        const env = commandEnv(parsed.argv[0] as string, { home: SCRATCH, ghToken: secrets().ghToken });
        return await runArgv(parsed.argv, { cwd: WORKSPACE, env, signal: abortSignal });
      },
    }),
    read_file: defineTool({ ...readFile, approval: ({ toolInput }) => approve("read", fileInput(toolInput), narrow) }),
    write_file: defineTool({ ...writeFile, approval: ({ toolInput }) => approve("write", fileInput(toolInput), narrow) }),
    glob: defineTool({ ...eveGlob, approval: ({ toolInput }) => approve("read", searchInput(toolInput), narrow) }),
    grep: defineTool({ ...eveGrep, approval: ({ toolInput }) => approve("read", searchInput(toolInput), narrow) }),
    web_fetch: defineTool({ ...webFetch, approval: ({ toolInput }) => approve("fetch", toolInput, narrow) }),
  };
}

export const { bash, read_file, write_file, glob, grep, web_fetch } = guarded();

/** A native subagent's guarded tools: its child run is read-only and runs only `commands`, whatever the stage may. */
export const readOnlyTools = (commands: string[]) => guarded({ writable: false, commands });

/** One call to the runner's bridge (run.ts) with the run's bearer token. node:http, not fetch:
 *  a delegated helper takes minutes, past fetch's own header and body timeouts. */
export function bridge(name: string, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(`${process.env.LUNA_EVE_BRIDGE_URL}/${name}`, { method: "POST", headers: { authorization: `Bearer ${secrets().bridgeToken}`, "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`luna ${name}: the runner answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(text) as unknown);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
}

/** A luna tool: the call goes to the runner's bridge. */
export function lunaTool(name: LunaTool) {
  return defineTool({
    description: LUNA_TOOLS[name].description,
    inputSchema: z.object(LUNA_TOOLS[name].input),
    execute: (input) => bridge(name, input),
  });
}
