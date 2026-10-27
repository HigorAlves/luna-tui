// Runs one stage in a fresh container and deletes it afterwards. The worktree is mounted at
// /work (read-only for read-only stages), the stage input at /in, and results come back in /out.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Credential } from "./credentials.ts";
import { type ExecResult, exec, execOrThrow } from "../process/exec.ts";

/** Label on every stage container, so leftovers can be found and removed. */
export const CONTAINER_LABEL = "dev.hardness.stage";
/** What one stage may take of the machine: one runaway build or fork bomb stays one slot's problem. */
export const SANDBOX_LIMITS = ["--memory", "4g", "--cpus", "2", "--pids-limit", "1024"];
/** `docker wait` gets this long past the stage's own timeout before the container is forced down. */
const WAIT_GRACE_MS = 60_000;
/** Where the repo's cache volume is mounted, and what each package manager is told to keep
 *  there: a retry, or the next task of the same repo, installs from a warm cache instead of
 *  the network. The worktree keeps its own node_modules; this is the store behind it. */
export const CACHE_DIR = "/cache";
export const CACHE_ENV = [
  `XDG_CACHE_HOME=${CACHE_DIR}`,
  `npm_config_cache=${CACHE_DIR}/npm`,
  `npm_config_store_dir=${CACHE_DIR}/pnpm-store`,
  `YARN_CACHE_FOLDER=${CACHE_DIR}/yarn`,
  `GOCACHE=${CACHE_DIR}/go-build`,
  `GOMODCACHE=${CACHE_DIR}/go-mod`,
  `CARGO_HOME=${CACHE_DIR}/cargo`,
  `PIP_CACHE_DIR=${CACHE_DIR}/pip`,
  `UV_CACHE_DIR=${CACHE_DIR}/uv`,
];

/** The docker volume holding one repo's caches: `hardness-cache-<repo>`, from the checkout's name. */
export function cacheVolumeFor(repoPath: string): string {
  const name = repoPath.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `hardness-cache-${slug}`;
}

/** The cache mount and env, when a volume is named. */
function cacheArgs(volume: string | undefined): string[] {
  if (!volume) return [];
  return ["-v", `${volume}:${CACHE_DIR}`, ...CACHE_ENV.flatMap((env) => ["-e", env])];
}

export interface SandboxRun {
  name: string;
  image: string;
  /** Folder for this run's input, output and transcript. */
  runDir: string;
  worktree: string;
  writable: boolean;
  /** The repo's git dir, mounted at the same path so git works inside: writable for a
   * writable stage, since committing writes objects, refs and the worktree's index there. */
  gitDir: string | null;
  /** Paths under `gitDir` to keep read-only even when the rest is writable: `hooks` and
   * `config`, so a stage cannot plant a hook (or point `core.hooksPath` at one) that the
   * host would then run as you. */
  gitReadOnly?: string[];
  /** Who a writable stage commits as. The container has no gitconfig of its own. */
  gitIdentity?: { name: string; email: string } | null;
  input: Record<string, unknown>;
  timeoutMs: number;
  credential: Credential;
  labels: Record<string, string>;
  /** Extra container env, for tooling such as the sandbox smoke. Not used by the machine. */
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
  /** Called once the container is running, e.g. to open a watch pane. */
  onStarted?: (container: string) => void;
  /** Sees each transcript line as it streams; a returned reason stops the container as stuck. */
  onLine?: (line: string) => string | null;
  /** Host dir mounted at /session for the SDK's session transcripts (`CLAUDE_CONFIG_DIR`),
   *  so a session outlives the attempt and a later run can resume it; without it, sessions
   *  live on the tmpfs and die with the container. */
  sessionMount?: string;
  /** The repo's cache volume (`cacheVolumeFor`), mounted at /cache with the package managers pointed at it. */
  cacheVolume?: string;
  /** The container is already running (a restart found it): wait on it instead of starting one. */
  attach?: boolean;
  /** `uid:gid` the container runs as. The run folder, the session dir and the worktree are bind
   *  mounts owned by the host user, so the stage must be that user to write them (the image's
   *  `node` user is uid 1000, which is not the host user on a Linux host). Defaults to the
   *  machine's own uid:gid; null keeps the image's user. */
  user?: string | null;
}

/** The machine's own uid:gid, the owner of everything it mounts; undefined where the platform has none. */
export function hostUser(): string | undefined {
  return typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined;
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Why `onLine` stopped the run, when it did. */
  stuck?: string | null;
  transcriptPath: string;
}

/** The `docker run` argument list for one stage. Pure: the credential is named, never valued. */
export function sandboxArgs(run: SandboxRun, inDir: string, outDir: string): string[] {
  const args = ["run", "-d", "--name", run.name, "--label", `${CONTAINER_LABEL}=1`];
  for (const [key, value] of Object.entries(run.labels)) args.push("--label", `${key}=${value}`);
  // The agent needs outbound network for the Anthropic API, so this isn't `--network none` —
  // but nothing it does needs write access outside its mounted worktree, /in, /out or /tmp.
  // The tmpfs is `exec`: Docker's default is noexec, and `go test` runs the test binary it
  // builds under TMPDIR. The worktree bind mount is executable anyway, so this hides nothing.
  args.push("--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges", ...SANDBOX_LIMITS);
  const user = run.user === undefined ? hostUser() : run.user;
  if (user) args.push("--user", user);
  args.push(
    // npm/yarn/pip caches, shell history and anything else that defaults to $HOME would
    // otherwise hit the now-read-only root filesystem — point HOME at the one writable,
    // throwaway place left: the tmpfs above.
    "-e", "HOME=/tmp",
    // Temp files live on the tmpfs; the SDK's sessions too, unless a host dir is mounted below.
    "-e", "TMPDIR=/tmp",
    "-e", `CLAUDE_CONFIG_DIR=${run.sessionMount ? "/session" : "/tmp/claude"}`,
    // The credential is passed by name; its value is only in docker's environment.
    "-e", run.credential.name,
    // The worktree is owned by the host user, not the container's; and there is no gpg key
    // in here, so a commit must not try to sign.
    "-e", "GIT_CONFIG_COUNT=2",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    "-e", "GIT_CONFIG_KEY_1=commit.gpgsign",
    "-e", "GIT_CONFIG_VALUE_1=false",
    "-v", `${run.worktree}:/work${run.writable ? "" : ":ro"}`,
    "-v", `${inDir}:/in:ro`,
    "-v", `${outDir}:/out`,
  );
  if (run.sessionMount) args.push("-v", `${run.sessionMount}:/session`);
  args.push(...cacheArgs(run.cacheVolume));
  if (run.gitDir) {
    args.push("-v", `${run.gitDir}:${run.gitDir}${run.writable ? "" : ":ro"}`);
    // Later mounts shadow earlier ones, so these ride over the writable mount above.
    if (run.writable) {
      for (const sub of run.gitReadOnly ?? []) args.push("-v", `${run.gitDir}/${sub}:${run.gitDir}/${sub}:ro`);
    }
  }
  if (run.gitIdentity) {
    const { name, email } = run.gitIdentity;
    for (const who of ["AUTHOR", "COMMITTER"]) {
      args.push("-e", `GIT_${who}_NAME=${name}`, "-e", `GIT_${who}_EMAIL=${email}`);
    }
  }
  for (const [key, value] of Object.entries(run.extraEnv ?? {})) args.push("-e", `${key}=${value}`);
  args.push(run.image);

  return args;
}

export async function runSandbox(run: SandboxRun): Promise<SandboxResult> {
  if (!run.attach) {
    const inDir = join(run.runDir, "in");
    const outDir = join(run.runDir, "out");
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(inDir, "stage.json"), JSON.stringify(run.input, null, 2));
    await execOrThrow("docker", sandboxArgs(run, inDir, outDir), {
      env: { ...process.env, [run.credential.name]: run.credential.value },
    });
  }
  run.onStarted?.(run.name);

  let timedOut = false;
  let aborted = false;
  const kill = () => void exec("docker", ["kill", run.name]);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, run.timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  run.signal?.addEventListener("abort", onAbort, { once: true });
  if (run.signal?.aborted) onAbort();
  let stuck: string | null = null;
  const follower = run.onLine ? followLogs(run.name, run.onLine, (reason) => { stuck = reason; kill(); }) : null;

  // An outer deadline: the kill above asks the container to stop; if the daemon never
  // reports it gone, this call must still return so the slot is freed.
  const waited = await exec("docker", ["wait", run.name], { timeoutMs: run.timeoutMs + WAIT_GRACE_MS });
  clearTimeout(timer);
  run.signal?.removeEventListener("abort", onAbort);
  follower?.kill("SIGKILL");

  const transcriptPath = join(run.runDir, "transcript.log");
  const logs = await exec("docker", ["logs", run.name]);
  await writeFile(transcriptPath, logs.stdout + logs.stderr);
  await exec("docker", ["rm", "-f", run.name]);

  const exitCode = waited.code === 0 ? Number(waited.stdout.trim()) : null;
  return { exitCode, timedOut, aborted, stuck, transcriptPath };
}

/** Streams the container's stdout line by line into `onLine`; the first reason it returns
 *  goes to `onStuck` once. Returns the follower process, to kill when the run is over. */
function followLogs(name: string, onLine: (line: string) => string | null, onStuck: (reason: string) => void) {
  const child = spawn("docker", ["logs", "-f", name], { stdio: ["ignore", "pipe", "ignore"] });
  let buffer = "";
  let done = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (done) return;
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const reason = onLine(line);
      if (reason) {
        done = true;
        onStuck(reason);
        return;
      }
    }
  });
  child.on("error", () => {});
  return child;
}

/** One command run in the stage image over a worktree: a project's own checks (verify Step
 *  A, the locked-test replay). On the host they would run against node_modules a Linux
 *  container installed, with Linux binaries in them. */
export interface SandboxExec {
  name: string;
  image: string;
  worktree: string;
  argv: string[];
  /** As for a stage: the host user, so what the check writes into the worktree stays the host's. */
  user?: string | null;
  /** The only env the command sees besides HOME and TMPDIR; never the host's. */
  env?: Record<string, string>;
  /** The repo's cache volume, as for a stage. */
  cacheVolume?: string;
}

/** The `docker run` argument list for one command. Pure. */
export function sandboxExecArgs(run: SandboxExec): string[] {
  const [command, ...rest] = run.argv;
  const args = ["run", "--rm", "--name", run.name, "--label", `${CONTAINER_LABEL}=1`];
  args.push("--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges", ...SANDBOX_LIMITS);
  const user = run.user === undefined ? hostUser() : run.user;
  if (user) args.push("--user", user);
  args.push("-e", "HOME=/tmp", "-e", "TMPDIR=/tmp");
  for (const [key, value] of Object.entries(run.env ?? {})) args.push("-e", `${key}=${value}`);
  args.push(...cacheArgs(run.cacheVolume));
  // Writable: a test runner writes its cache next to the code (node_modules/.vite, go's are on the tmpfs).
  args.push("-v", `${run.worktree}:/work`, "-w", "/work", "--entrypoint", command!, run.image, ...rest);
  return args;
}

/** Runs the command and resolves with its exit code and output. A timeout or abort kills the
 *  docker client; the container is then removed by name, so it never outlives the call. */
export async function execInSandbox(
  run: SandboxExec,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const result = await exec("docker", sandboxExecArgs(run), options);
  await exec("docker", ["rm", "-f", run.name]);
  return result;
}

/** An `exec` for the stages that run a project's checks: same signature as the host one,
 *  `cwd` is the worktree, and only HARDNESS_* env reaches the container. The cache volume is
 *  the repo's: task worktrees live at `<worktreesDir>/<repo>/task-…`, so the parent names it. */
export function sandboxExecutor(image: string) {
  return (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ExecResult> => {
    if (!options.cwd) throw new Error("sandboxExecutor needs cwd: the worktree to mount");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (key.startsWith("HARDNESS_") && typeof value === "string") env[key] = value;
    }
    return execInSandbox(
      {
        name: `hardness-check-${randomUUID().slice(0, 8)}`,
        image,
        worktree: options.cwd,
        argv: [command, ...args],
        env,
        cacheVolume: cacheVolumeFor(dirname(options.cwd)),
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
  };
}

/** Removes stage containers a previous machine left behind: the stopped ones. A container still
 *  running is left for recover() to re-attach to, or to remove once it decides not to. */
export async function removeLeftoverContainers(): Promise<number> {
  const statuses = ["exited", "created", "dead"].flatMap((status) => ["--filter", `status=${status}`]);
  const listed = await exec("docker", ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}=1`, ...statuses]);
  const ids = listed.stdout.split("\n").filter(Boolean);
  if (ids.length > 0) await exec("docker", ["rm", "-f", ...ids]);
  return ids.length;
}

/** True while a container of that name is running. */
export async function containerRunning(name: string): Promise<boolean> {
  const inspected = await exec("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  return inspected.code === 0 && inspected.stdout.trim() === "true";
}

/** Stops and removes one container by name; nothing happens when it is already gone. */
export async function removeContainer(name: string): Promise<void> {
  await exec("docker", ["rm", "-f", name]);
}

export async function imageExists(image: string): Promise<boolean> {
  return (await exec("docker", ["image", "inspect", image])).code === 0;
}
