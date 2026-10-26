import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell and resolves with its exit code instead of throwing.
 *  `signal` kills the process early (e.g. the task was aborted); `timeoutMs` kills it after
 *  that long regardless — without one, a hung command blocks its caller (and whatever slot
 *  it's holding) forever. */
export function exec(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout or abort kills everything the command spawned
    // (a test runner behind `pnpm test`, a dev server behind a script), not only the shell
    // in front of it; a grandchild left alive would also hold our stdout pipe open forever.
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killGroup = () => {
      killed = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(killGroup, options.timeoutMs);
    if (options.signal?.aborted) killGroup();
    else options.signal?.addEventListener("abort", killGroup, { once: true });
    const done = (code: number) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", killGroup);
      resolve({ code, stdout, stderr });
    };
    child.on("error", (error) => {
      // Could not start (ENOENT and friends): report it where the caller reads failures.
      if (!stderr) stderr = error.message;
      done(1);
    });
    // A signal death has no exit code; a group we killed never counts as a success.
    child.on("close", (code) => done(killed ? (code || 1) : (code ?? 1)));
  });
}

/** Like `exec`, but throws with stderr when the command fails. */
export async function execOrThrow(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string> {
  const result = await exec(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}
