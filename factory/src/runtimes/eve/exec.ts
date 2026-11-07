// eve's `bash` without a shell: a command line becomes one argv (core/argv.ts) and runs as one
// process, with an environment named here rather than inherited. A shell would expand, redirect
// and chain whatever the guard let through, and a login shell would source a profile any earlier
// command could have written and reset PATH from /etc/profile.
import { spawn } from "node:child_process";
import { dirname } from "node:path";

/** The stage image's toolchains first (Go, Cargo, the node running this), then the usual dirs. */
export const STAGE_PATH = [...new Set([dirname(process.execPath), "/usr/local/go/bin", "/usr/local/cargo/bin", "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"])].join(":");

/** What a command may inherit from the server: locale, git's config, the toolchains' homes and
 *  caches, and the egress proxy (the sandbox refuses every other way out: without it pnpm, cargo and
 *  npm cannot reach a registry the repo allows). Nothing that holds a credential or names one of the
 *  runner's files: the proxy URL is `http://<address>:<port>`, with no user or password. */
const INHERITED = /^(LANG|LC_[A-Z]+|TZ|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL|GOTOOLCHAIN|GOPATH|GOCACHE|GOMODCACHE|GOFLAGS|RUSTUP_HOME|CARGO_HOME|CARGO_TARGET_DIR|npm_config_cache|COREPACK_HOME|COREPACK_ENABLE_DOWNLOAD_PROMPT|COREPACK_DEFAULT_TO_LATEST|PNPM_HOME|CI|LUNA_FACTORY|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|YARN_HTTPS?_PROXY|NODE_USE_ENV_PROXY)$/;

export interface CommandEnvOptions {
  /** The server's environment, to pick the inherited variables from. */
  source?: NodeJS.ProcessEnv;
  /** HOME and TMPDIR for the command: the run's scratch folder. */
  home: string;
  /** The GitHub token, handed to `gh` only (it reads issues and PRs with it). */
  ghToken?: string;
}

/** The environment one command runs with. */
export function commandEnv(command: string, { source = process.env, home, ghToken }: CommandEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && INHERITED.test(key)) env[key] = value;
  // TERM=dumb keeps escape codes out of what the model reads. No NO_COLOR: it changes what a program does, not only how it prints
  // (a TUI's colour tests fail under it), and the repo's CI does not set it, so a check would fail here and pass there.
  Object.assign(env, { PATH: STAGE_PATH, HOME: home, TMPDIR: home, TERM: "dumb" });
  if (command === "gh" && ghToken) env.GH_TOKEN = ghToken;
  return env;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** The output a call returns, at most: the tail, as eve's own tools keep it. */
const MAX_OUTPUT_BYTES = 50 * 1024;

/** Collects a stream, keeping its last MAX_OUTPUT_BYTES. */
function tail(stream: NodeJS.ReadableStream | null): { text: () => string; truncated: () => boolean } {
  let chunks: Buffer[] = [];
  let size = 0;
  let dropped = false;
  stream?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.byteLength;
    if (size > 2 * MAX_OUTPUT_BYTES) {
      const kept = Buffer.concat(chunks).subarray(-MAX_OUTPUT_BYTES);
      chunks = [kept];
      size = kept.byteLength;
      dropped = true;
    }
  });
  return {
    text: () => {
      const all = Buffer.concat(chunks);
      if (all.byteLength > MAX_OUTPUT_BYTES) dropped = true;
      return all.subarray(-MAX_OUTPUT_BYTES).toString("utf8");
    },
    truncated: () => dropped,
  };
}

/** Runs argv as one process in its own process group; an abort kills the group. Never throws. */
export function runArgv(argv: string[], { cwd, env, signal }: { cwd: string; env: Record<string, string>; signal?: AbortSignal }): Promise<ExecResult> {
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(command as string, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = tail(child.stdout);
    const stderr = tail(child.stderr);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    if (signal?.aborted) kill();
    signal?.addEventListener("abort", kill, { once: true });
    const done = (exitCode: number, error?: string) => {
      signal?.removeEventListener("abort", kill);
      const err = stderr.text();
      resolve({ exitCode, stdout: stdout.text(), stderr: error ? `${err}${error}` : err, truncated: stdout.truncated() || stderr.truncated() });
    };
    child.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT" ? 127 : 126, error.code === "ENOENT" ? `${command}: command not found` : error.message));
    child.once("close", (code, sig) => done(code ?? (sig ? 128 : 1)));
  });
}
