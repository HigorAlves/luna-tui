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

// Commands the model runs must not inherit the runner's secrets: the per-run API password, the
// bridge token, the model credentials. GH_TOKEN stays: the stage holds it to read, as on Claude.
// The Codex auth file itself stays readable to the same uid: the guards refuse any path under
// the Codex home instead (core/guards.ts, deniedRoots).
const SECRET_ENV = /^(LUNA_EVE_PASSWORD|LUNA_EVE_BRIDGE_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$|CODEX/i;
function commandEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_ENV.test(key)) env[key] = value;
  return { ...env, ...SANDBOX_AGENT_ENV, ...extra };
}

function connect(root: string): SandboxConnection {
  return {
    workspaceRoot: root,
    async spawn({ command, env, workingDirectory, signal, stdin }) {
      const child = spawn("bash", ["-lc", command], {
        cwd: workingDirectory,
        env: commandEnv(env),
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
