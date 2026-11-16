// A policy that names another container runtime (`runtime.untrusted: runsc`, gVisor) needs the daemon to have it: `docker run --runtime x` on a
// daemon without it fails each stage with a message about docker. The machine asks once and escalates the card as env_broken.
import type { ExecResult } from "../process/exec.ts";

/** The daemon does not list the runtime the machine policy names. */
export class RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

type Exec = (command: string, args: string[]) => Promise<ExecResult>;

/** Throws `RuntimeUnavailableError` unless `docker info` lists `runtime` (`runc` is docker's own and is never asked). */
export async function assertRuntime(exec: Exec, runtime: string): Promise<void> {
  if (runtime === "runc") return;
  const info = await exec("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (info.code !== 0) throw new RuntimeUnavailableError(`the container runtime ${runtime} could not be checked: ${info.stderr.trim().slice(0, 160) || "docker info failed"}`);
  let runtimes: unknown;
  try {
    runtimes = JSON.parse(info.stdout.trim());
  } catch {
    throw new RuntimeUnavailableError(`the container runtime ${runtime} could not be checked: docker info did not answer JSON`);
  }
  if (typeof runtimes !== "object" || runtimes === null || !Object.hasOwn(runtimes, runtime)) {
    throw new RuntimeUnavailableError(`the machine's sandbox policy names the container runtime ${runtime}, and the daemon has none of that name`);
  }
}

/** `assertRuntime` once per runtime and process; only a pass is remembered. */
export function runtimeChecker(exec: Exec): (runtime: string) => Promise<void> {
  const passed = new Set<string>();
  return async (runtime) => {
    if (passed.has(runtime)) return;
    await assertRuntime(exec, runtime);
    passed.add(runtime);
  };
}
