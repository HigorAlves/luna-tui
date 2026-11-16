// The daemon's seccomp filter is what keeps a stage container's syscalls to the default set. A daemon without it (or with it
// switched off) runs every stage with the kernel's whole surface, so the machine runs no stage on it: the card is escalated as env_broken.
import type { ExecResult } from "../process/exec.ts";

/** The daemon has no seccomp filter, or its default profile is `unconfined`. */
export class SeccompUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeccompUnavailableError";
  }
}

type Exec = (command: string, args: string[]) => Promise<ExecResult>;

/** Throws `SeccompUnavailableError` unless `docker info` lists `name=seccomp` with a profile other than `unconfined`. */
export async function assertSeccomp(exec: Exec): Promise<void> {
  const info = await exec("docker", ["info", "--format", "{{json .SecurityOptions}}"]);
  if (info.code !== 0) throw new SeccompUnavailableError(`the daemon's security options could not be read: ${info.stderr.trim().slice(0, 160) || "docker info failed"}`);
  let options: unknown;
  try {
    options = JSON.parse(info.stdout.trim());
  } catch {
    throw new SeccompUnavailableError("the daemon's security options could not be read: docker info did not answer JSON");
  }
  const entry = Array.isArray(options) ? options.find((option) => typeof option === "string" && /(^|,)name=seccomp(,|$)/.test(option)) : undefined;
  if (typeof entry !== "string") throw new SeccompUnavailableError("the daemon has no seccomp filter (docker info lists no name=seccomp)");
  if (/(^|,)profile=unconfined(,|$)/.test(entry)) throw new SeccompUnavailableError("the daemon's default seccomp profile is unconfined");
}

/** `assertSeccomp` once per process: a daemon does not gain a filter while the machine runs, so only a pass is remembered. */
export function seccompChecker(exec: Exec): () => Promise<void> {
  let passed = false;
  return async () => {
    if (passed) return;
    await assertSeccomp(exec);
    passed = true;
  };
}
