import { spawn } from "node:child_process";

/** The cap a caller sets for output it does not control (a container's): the tail of each stream, 4 MiB. */
export const OUTPUT_CAP = 4 * 1024 * 1024;

/** What a stream with no cap may hold: 256 MiB. Past it the command is killed and fails, because a string longer than V8's limit (about 512 MB) cannot be built and the throw would take the machine down. */
export const UNCAPPED_LIMIT = 256 * 1024 * 1024;

/** One stream's output: every byte, or only the last `cap` bytes when a cap is set. Bytes are kept, not text, so a character split across two chunks
 *  stays whole, and a capped stream is trimmed once it holds twice its cap: the cost per byte stays constant however much a command prints. */
function collector(cap: number | undefined, limit: number, onOver: () => void): { add(chunk: Buffer): void; text(): string; over(): boolean } {
  let exceeded = false;
  let chunks: Buffer[] = [];
  let bytes = 0;
  const tail = (): Buffer => {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    return cap !== undefined && all.length > cap ? all.subarray(all.length - cap) : all;
  };
  return {
    over: () => exceeded,
    add(chunk) {
      if (exceeded) return;
      if (cap === undefined && bytes + chunk.length > limit) {
        exceeded = true;
        chunks = [];
        bytes = 0;
        onOver();
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
      if (cap !== undefined && bytes > cap * 2) {
        const kept = Buffer.from(tail());
        chunks = [kept];
        bytes = kept.length;
      }
    },
    text: () => tail().toString(),
  };
}

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
  options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; outputCap?: number; maxBytes?: number } = {},
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
    // `outputCap` is for output the machine does not control: a test run in a sandbox cannot fill its memory, and the end is where the failure
    // is. Without one every byte is kept: a file list or a diff is never cut without its caller asking.
    let killed = false;
    const limit = options.maxBytes ?? UNCAPPED_LIMIT;
    const stdout = collector(options.outputCap, limit, () => killGroup());
    const stderr = collector(options.outputCap, limit, () => killGroup());
    let startError = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
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
      if (stdout.over() || stderr.over()) {
        resolve({ code: code || 1, stdout: "", stderr: `output over ${limit} bytes: the command was stopped` });
        return;
      }
      resolve({ code, stdout: stdout.text(), stderr: stderr.text() || startError });
    };
    child.on("error", (error) => {
      // Could not start (ENOENT and friends): report it where the caller reads failures.
      startError = error.message;
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
