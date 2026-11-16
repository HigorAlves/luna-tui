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

/** Throws `RuntimeUnavailableError` unless `docker info` lists `runtime` (`runc` is docker's own and is never asked). gVisor (`runsc`)
 *  is refused on Docker Desktop too: it shows the files Docker Desktop shares from the host as root's, so a stage's uid could not
 *  read its worktree or enter a 0700 folder (seen on Docker Desktop 4.99 with gVisor's every file-access mode; RFC 0009). */
export async function assertRuntime(exec: Exec, runtime: string): Promise<void> {
  if (runtime === "runc") return;
  const info = await exec("docker", ["info", "--format", '{"runtimes":{{json .Runtimes}},"os":{{json .OperatingSystem}}}']);
  if (info.code !== 0) throw new RuntimeUnavailableError(`the container runtime ${runtime} could not be checked: ${info.stderr.trim().slice(0, 160) || "docker info failed"}`);
  let answer: { runtimes?: unknown; os?: unknown };
  try {
    answer = JSON.parse(info.stdout.trim()) as { runtimes?: unknown; os?: unknown };
  } catch {
    throw new RuntimeUnavailableError(`the container runtime ${runtime} could not be checked: docker info did not answer JSON`);
  }
  const { runtimes, os } = answer ?? {};
  if (typeof runtimes !== "object" || runtimes === null || !Object.hasOwn(runtimes, runtime)) {
    throw new RuntimeUnavailableError(`the machine's sandbox policy names the container runtime ${runtime}, and the daemon has none of that name`);
  }
  if (runtime === "runsc" && typeof os === "string" && /docker desktop/i.test(os)) {
    throw new RuntimeUnavailableError("gVisor (runsc) cannot run Luna's stages on Docker Desktop: it shows the files shared from the host as root's, so a stage could not read its worktree. Use runsc on a native Linux docker host, or set the policy's runtime back to runc");
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
