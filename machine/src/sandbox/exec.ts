import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell and resolves with its exit code instead of throwing. */
export function exec(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: options.env ?? process.env, cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
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
