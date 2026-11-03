// The stage-local sandbox: commands run as child processes of the eve server, in the stage
// container itself, with the stage's work dir as the workspace root. No Docker, no VM, no virtual
// filesystem: the container the machine started is the sandbox (read-only root, /work mounted,
// no-new-privileges). The runner names the work dir in LUNA_EVE_WORKSPACE.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { defineSandbox } from "eve/sandbox";
import { defineSandboxProvider, SANDBOX_AGENT_ENV, type SandboxConnection } from "eve/sandbox/provider";

import { commandEnv } from "./exec.ts";

// What eve runs here itself (glob's and grep's searches, its own job bookkeeping) is a script it
// builds with every model input quoted; the model's commands never come here (agent/tools.ts runs
// them as one process each). Neither inherits the server's environment: an explicit one, without
// a credential, and a non-login shell with no profile or rc file, so nothing a command wrote can
// run later and PATH keeps the image's toolchains.
function scriptEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  return { ...commandEnv("bash", { home: process.env.LUNA_EVE_SCRATCH || "/nonexistent" }), ...SANDBOX_AGENT_ENV, ...extra };
}

function connect(root: string): SandboxConnection {
  return {
    workspaceRoot: root,
    async spawn({ command, env, workingDirectory, signal, stdin }) {
      const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
        cwd: workingDirectory,
        env: scriptEnv(env),
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true, // own process group, so kill() takes the whole tree
        signal,
      });
      const exited = new Promise<{ exitCode: number }>((resolve) => {
        child.once("close", (code, sig) => resolve({ exitCode: code ?? (sig ? 128 : 1) }));
        child.once("error", () => resolve({ exitCode: 127 }));
      });
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        ...(stdin && child.stdin ? { stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array> } : {}),
        wait: () => exited,
        kill: async () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        },
      };
    },
    async readFile({ path }) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeFiles({ files }) {
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content);
      }
    },
    async removePath({ path, force, recursive }) {
      await rm(path, { force: force ?? false, recursive: recursive ?? false });
    },
    async stop() {},
  };
}

export const LocalSandbox = defineSandboxProvider({
  name: "stage-local",
  environment(options: { readonly root?: string }) {
    const root = options.root ?? "/work";
    return {
      // Nothing to bake: the stage image is the template.
      async prepare() {
        return { root };
      },
      async start() {
        return { connection: connect(root), state: { root } };
      },
      async resume(_ctx, _artifact, state) {
        return connect(state.root);
      },
      // The worktree belongs to the machine, never deleted by eve.
      async onSessionEnd() {},
    };
  },
});

export const environment = LocalSandbox.environment({ root: process.env.LUNA_EVE_WORKSPACE || "/work" });
export default defineSandbox(() => environment.open());
