// Runs one stage in a fresh container and deletes it afterwards. The worktree is mounted at
// /work (read-only for read-only stages), the stage input at /in, and results come back in /out.
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ServiceSpec } from "@hardness/contracts";

import type { CredentialMount, RunCredential } from "../credentials/index.ts";
import { redactDeep, secretRedactor } from "../../domain/redact-secrets.ts";
import type { SecretStore } from "../../application/secrets.ts";
import { type BlockedRow, type CardNetwork, findCardNetwork, openCardNetwork } from "./egress.ts";
import { serviceName, startServices } from "./services.ts";
import { type ExecResult, exec, execOrThrow } from "../process/exec.ts";

/** Label on every stage container, so leftovers can be found and removed. */
export const CONTAINER_LABEL = "dev.hardness.stage";
/** What one stage may take of the machine: one runaway build or fork bomb stays one slot's problem. */
/** What a container may use: `sandbox.cpu` and `sandbox.memory_gb` of luna.yaml (the defaults are 2 and 4, below the diagram's 4 and 8 by the user's decision); the process limit is fixed. */
export interface SandboxSize {
  cpu: number;
  memoryGb: number;
}
export const DEFAULT_SANDBOX_SIZE: SandboxSize = { cpu: 2, memoryGb: 4 };
export const sandboxLimits = (size: SandboxSize = DEFAULT_SANDBOX_SIZE): string[] => ["--memory", `${size.memoryGb}g`, "--cpus", `${size.cpu}`, "--pids-limit", "1024"];
export const SANDBOX_LIMITS = sandboxLimits();
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
  `CARGO_TARGET_DIR=${CACHE_DIR}/cargo-target`,
  `PIP_CACHE_DIR=${CACHE_DIR}/pip`,
  `UV_CACHE_DIR=${CACHE_DIR}/uv`,
  // The package manager an install fetched is here for an agent whose registries are closed.
  `COREPACK_HOME=${CACHE_DIR}/corepack`,
];
/** Corepack never prompts and never takes the latest version of a package manager, in any container. */
const COREPACK_ENV = ["COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "COREPACK_DEFAULT_TO_LATEST=0"];

/** Variables a repository's image must not set for the process the machine starts in it (`ENV NODE_OPTIONS=--require=...` would run its code in the factory before the guards load): every container the machine starts passes them empty. */
export const BLANKED_ENV = ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const blankedEnv = (): string[] => BLANKED_ENV.flatMap((name) => ["-e", `${name}=`]);

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
  /** The user's repository's git dir, for a checkout run that reads the repository itself, mounted at the same path so git
   * works inside: always read-only, whatever the run. A card's workspace has no git dir mounted (its repository is the machine's). */
  gitDir: string | null;
  /** The container's CPUs and memory; absent, the defaults (2 CPUs, 4 GB). */
  limits?: SandboxSize;
  /** Who a writable stage commits as. The container has no gitconfig of its own. */
  gitIdentity?: { name: string; email: string } | null;
  input: Record<string, unknown>;
  timeoutMs: number;
  /** Only the stage's own engine's credential: variables passed by name, and mounts (the Codex login's per-run copy). */
  credential: Pick<RunCredential, "env" | "mounts">;
  labels: Record<string, string>;
  /** Extra container env: the run's trace context (StageContext.traceEnv), or tooling such as the sandbox smoke. */
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
  /** The repo's services (luna.yaml), started beside the container on its own network. */
  services?: Record<string, ServiceSpec>;
  /** Set by `runSandbox` once the services are up: the network to join and what they export. */
  network?: string | null;
  /** Join no network at all: for a job that needs none (the graph build parses untrusted code). Ignored when a service network is given. */
  networkNone?: boolean;
  serviceEnv?: Record<string, string>;
  /** The list this run may reach (`egressFor`), and the machine's own image the proxy runs from (never a repository's). `runSandbox` opens a card network with a proxy for it, and removes both when the run ends. */
  egress?: { allow: readonly string[]; allowPrivate: readonly string[]; proxyImage: string };
  /** Secret values by name, for this run only: passed as `-e NAME`, the values in the docker client's environment alone. */
  secrets?: Record<string, string>;
  /** The run's card network (egress.ts): joined in place of the plain network, with the proxy as the only way out. */
  cardNetwork?: CardNetwork;
  /** More networks to join, by name (the browser run joins the app's). */
  alsoJoin?: string[];
  /** `uid:gid` the container runs as. The run folder, the session dir and the worktree are bind
   *  mounts owned by the host user, so the stage must be that user to write them (the image's
   *  `node` user is uid 1000, which is not the host user on a Linux host). Defaults to the
   *  machine's own uid:gid; null keeps the image's user. */
  user?: string | null;
  /** Extra bind mounts, after the credential's (a repo's code graph at `/graph`, read-only). */
  mounts?: CredentialMount[];
  /** Replaces the image's entrypoint: the first element is the program, the rest its arguments. */
  entrypoint?: string[];
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
  /** What the run's proxy refused (untrusted text, flattened); absent for a run with no card network. */
  blocked?: BlockedRow[];
}

/** What `runSandbox` and `execInSandbox` call out to; the host's by default, a fake in a test. */
export interface RunDeps {
  exec: typeof exec;
  execOrThrow: typeof execOrThrow;
  startServices: typeof startServices;
  openCardNetwork: typeof openCardNetwork;
  findCardNetwork: typeof findCardNetwork;
}
const HOST_DEPS: RunDeps = { exec, execOrThrow, startServices, openCardNetwork, findCardNetwork };

/** The `docker run` argument list for one stage. Pure: the credential's variables are named, never valued. */
export function sandboxArgs(run: SandboxRun, inDir: string, outDir: string): string[] {
  const args = ["run", "-d", "--name", run.name, "--label", `${CONTAINER_LABEL}=1`];
  for (const [key, value] of Object.entries(run.labels)) args.push("--label", `${key}=${value}`);
  // The agent needs outbound network for the Anthropic API, so this isn't `--network none` —
  // but nothing it does needs write access outside its mounted worktree, /in, /out or /tmp.
  // The tmpfs is `exec`: Docker's default is noexec, and `go test` runs the test binary it
  // builds under TMPDIR. The worktree bind mount is executable anyway, so this hides nothing.
  args.push("--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges", ...sandboxLimits(run.limits));
  const user = run.user === undefined ? hostUser() : run.user;
  if (user) args.push("--user", user);
  args.push(
    // npm/yarn/pip caches, shell history and anything else that defaults to $HOME would
    // otherwise hit the now-read-only root filesystem — point HOME at the one writable,
    // throwaway place left: the tmpfs above.
    "-e", "HOME=/tmp",
    ...COREPACK_ENV.flatMap((env) => ["-e", env]),
    ...blankedEnv(),
    // Temp files live on the tmpfs; the SDK's sessions too, unless a host dir is mounted below.
    "-e", "TMPDIR=/tmp",
    "-e", `CLAUDE_CONFIG_DIR=${run.sessionMount ? "/session" : "/tmp/claude"}`,
    // The credential is passed by name; its value is only in docker's environment.
    ...Object.keys(run.credential.env).flatMap((name) => ["-e", name]),
    // A scoped secret the same way: by name here, the value only in docker's environment.
    ...Object.keys(run.secrets ?? {}).flatMap((name) => ["-e", name]),
    // The worktree is owned by the host user, not the container's; and there is no gpg key
    // in here, so a commit must not try to sign.
    ...GIT_CONFIG_ENV.flatMap((env) => ["-e", env]),
    "-v", `${run.worktree}:/work${run.writable ? "" : ":ro"}`,
    "-v", `${inDir}:/in:ro`,
    "-v", `${outDir}:/out`,
  );
  if (run.sessionMount) args.push("-v", `${run.sessionMount}:/session`);
  for (const mount of run.credential.mounts) args.push("-v", `${mount.host}:${mount.container}${mount.readOnly ? ":ro" : ""}`);
  for (const mount of run.mounts ?? []) args.push("-v", `${mount.host}:${mount.container}${mount.readOnly ? ":ro" : ""}`);
  args.push(...cacheArgs(run.cacheVolume));
  if (run.gitDir) {
    args.push("-v", `${run.gitDir}:${run.gitDir}:ro`);
  }
  args.push(...identityEnv(run.gitIdentity));
  // A trace backend on the host (docs/configuration.md "Observability"): Docker Desktop resolves
  // host.docker.internal by itself, Linux needs the gateway alias.
  // On a card network the host is not reachable at all: a trace endpoint there is the proxy's private entry, never an alias in the stage.
  if (!run.cardNetwork && Object.values(run.extraEnv ?? {}).some((value) => value.includes("host.docker.internal"))) args.push("--add-host", "host.docker.internal:host-gateway");
  args.push(...networkArgs(run.network, run.serviceEnv, run.networkNone, run.cardNetwork, run.alsoJoin, Object.keys(run.services ?? {})));
  // The run's own extra env last: docker keeps the last value, so a repo's service exports
  // (luna.yaml) never redirect the trace context the machine set.
  for (const [key, value] of Object.entries(run.extraEnv ?? {})) args.push("-e", `${key}=${value}`);
  const [program, ...rest] = run.entrypoint ?? [];
  if (program) args.push("--entrypoint", program);
  args.push(run.image, ...rest);

  return args;
}

/** The network to join and what the services export, when a run has any. A card network comes after the service env, so an export cannot take the proxy variables; `alsoJoin` adds networks by name. */
function networkArgs(network: string | null | undefined, serviceEnv: Record<string, string> | undefined, none?: boolean, card?: CardNetwork, alsoJoin?: string[], aliases: string[] = []): string[] {
  const env = Object.entries(serviceEnv ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  if (card) return [...env, ...card.containerArgs(aliases), ...(alsoJoin ?? []).flatMap((name) => ["--network", name])];
  if (!network) return none ? ["--network", "none"] : [];
  return ["--network", network, ...env];
}

export async function runSandbox(run: SandboxRun, given: Partial<RunDeps> = {}): Promise<SandboxResult> {
  const deps: RunDeps = { ...HOST_DEPS, ...given };
  // The run's own card network, when it has a list: opened here and removed in `finally`, whatever the outcome. A card network
  // it is handed (the browser run's, the app's) is joined and left alone; a re-attached run's is found by name and removed at its end.
  let own: CardNetwork | null = null;
  if (run.attach) own = run.cardNetwork ? null : run.egress ? await deps.findCardNetwork(run.name) : null;
  else if (!run.cardNetwork && run.egress) own = await deps.openCardNetwork(run.name, run.egress, { proxyImage: run.egress.proxyImage });
  const card = run.cardNetwork ?? own;
  try {
    // A re-attached run's services are still up from before; they are torn down with it below.
    const services = run.attach
      ? { network: null, env: {}, teardown: async () => void (await Promise.all(Object.keys(run.services ?? {}).map((key) => deps.exec("docker", ["rm", "-f", serviceName(run.name, key)])))) }
      : await deps.startServices(run.name, run.services ?? {}, card ? { network: { name: card.name, dns: card.dns } } : {});
    try {
      if (!run.attach) {
        const inDir = join(run.runDir, "in");
        const outDir = join(run.runDir, "out");
        await mkdir(inDir, { recursive: true });
        await mkdir(outDir, { recursive: true });
        await writeFile(join(inDir, "stage.json"), JSON.stringify(run.input, null, 2));
        await deps.execOrThrow("docker", sandboxArgs({ ...run, ...(card ? { cardNetwork: card } : {}), network: services.network, serviceEnv: services.env }, inDir, outDir), {
          env: { ...process.env, ...run.credential.env, ...(run.secrets ?? {}) },
        });
      }
      const redact = secretRedactor(run.secrets ?? {});
      const result = await waitSandbox(run, deps.exec, redact);
      return own ? { ...result, blocked: ((await own.blocked()) as BlockedRow[]).map((row) => ({ ...row, host: redact(row.host) })) } : result;
    } finally {
      await services.teardown();
    }
  } finally {
    await own?.teardown();
  }
}

async function waitSandbox(run: SandboxRun, exec: RunDeps["exec"], redact: (text: string) => string = (text) => text): Promise<SandboxResult> {
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
  await writeFile(transcriptPath, redact(logs.stdout + logs.stderr));
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
  /** CPUs and memory; absent, the defaults. */
  limits?: SandboxSize;
  argv: string[];
  /** As for a stage: the host user, so what the check writes into the worktree stays the host's. */
  user?: string | null;
  /** The only env the command sees besides HOME and TMPDIR; never the host's. */
  env?: Record<string, string>;
  /** The repo's cache volume, as for a stage. */
  cacheVolume?: string;
  /** Who a commit the check makes is by: a suite that commits in a scratch repo needs one,
   *  and the container has no gitconfig. */
  gitIdentity?: { name: string; email: string } | null;
  /** The repo's services, started beside the check; `network` and `serviceEnv` once they are up. */
  services?: Record<string, ServiceSpec>;
  network?: string | null;
  serviceEnv?: Record<string, string>;
  /** Secret values by name for this command only, passed as `-e NAME`; the values go in the docker client's environment alone. */
  secrets?: Record<string, string>;
  /** The list the check may reach, as for a stage; `execInSandbox` opens and removes the network. */
  egress?: { allow: readonly string[]; allowPrivate: readonly string[]; proxyImage: string };
  /** The check's card network and any more networks to join, as for a stage. */
  cardNetwork?: CardNetwork;
  alsoJoin?: string[];
  /** A linked worktree's `.git` file, mounted read-only over `/work/.git` so the check cannot repoint it. */
  gitFile?: string;
}

/** Git config every container gets by env: the mounted worktree is another user's to git,
 *  and there is no key to sign with. */
const GIT_CONFIG_ENV = [
  "GIT_CONFIG_COUNT=2",
  "GIT_CONFIG_KEY_0=safe.directory",
  "GIT_CONFIG_VALUE_0=*",
  "GIT_CONFIG_KEY_1=commit.gpgsign",
  "GIT_CONFIG_VALUE_1=false",
];

const identityEnv = (identity: { name: string; email: string } | null | undefined): string[] =>
  identity
    ? ["AUTHOR", "COMMITTER"].flatMap((who) => ["-e", `GIT_${who}_NAME=${identity.name}`, "-e", `GIT_${who}_EMAIL=${identity.email}`])
    : [];

/** The `docker run` argument list for one command. Pure. */
export function sandboxExecArgs(run: SandboxExec): string[] {
  const [command, ...rest] = run.argv;
  const args = ["run", "--rm", "--name", run.name, "--label", `${CONTAINER_LABEL}=1`];
  args.push("--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges", ...sandboxLimits(run.limits));
  const user = run.user === undefined ? hostUser() : run.user;
  if (user) args.push("--user", user);
  args.push("-e", "HOME=/tmp", "-e", "TMPDIR=/tmp", ...COREPACK_ENV.flatMap((env) => ["-e", env]), ...blankedEnv(), ...GIT_CONFIG_ENV.flatMap((env) => ["-e", env]), ...identityEnv(run.gitIdentity));
  for (const [key, value] of Object.entries(run.env ?? {})) args.push("-e", `${key}=${value}`);
  for (const name of Object.keys(run.secrets ?? {})) args.push("-e", name);
  args.push(...cacheArgs(run.cacheVolume));
  args.push(...networkArgs(run.network, run.serviceEnv, false, run.cardNetwork, run.alsoJoin, Object.keys(run.services ?? {})));
  // Writable: a test runner writes its cache next to the code (node_modules/.vite, go's are on the tmpfs).
  args.push("-v", `${run.worktree}:/work`);
  // Later mounts shadow earlier ones: the pointer file stays the machine's.
  if (run.gitFile) args.push("-v", `${run.gitFile}:/work/.git:ro`);
  args.push("-w", "/work", "--entrypoint", command!, run.image, ...rest);
  return args;
}

/** Runs the command and resolves with its exit code and output. A timeout or abort kills the
 *  docker client; the container is then removed by name, so it never outlives the call. */
export async function execInSandbox(
  run: SandboxExec,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
  given: Partial<RunDeps> = {},
): Promise<ExecResult & { blocked?: BlockedRow[] }> {
  const deps: RunDeps = { ...HOST_DEPS, ...given };
  const own = !run.cardNetwork && run.egress ? await deps.openCardNetwork(run.name, run.egress, { proxyImage: run.egress.proxyImage }) : null;
  const card = run.cardNetwork ?? own;
  try {
    const services = await deps.startServices(run.name, run.services ?? {}, card ? { network: { name: card.name, dns: card.dns } } : {});
    try {
      const result = await deps.exec("docker", sandboxExecArgs({ ...run, ...(card ? { cardNetwork: card } : {}), network: services.network, serviceEnv: services.env }), { ...options, ...(run.secrets ? { env: { ...process.env, ...run.secrets } } : {}) });
      await deps.exec("docker", ["rm", "-f", run.name]);
      const redact = secretRedactor(run.secrets ?? {});
      const clean = run.secrets ? { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) } : result;
      return own ? { ...clean, blocked: ((await own.blocked()) as BlockedRow[]).map((row) => ({ ...row, host: redact(row.host) })) } : clean;
    } finally {
      await services.teardown();
    }
  } finally {
    await own?.teardown();
  }
}

/** An `exec` for the stages that run a project's checks: same signature as the host one,
 *  `cwd` is the worktree, and only HARDNESS_* env and the git identity (GIT_AUTHOR_*,
 *  GIT_COMMITTER_*) reach the container. The cache volume is the repo's: task worktrees live
 *  at `<worktreesDir>/<repo>/task-…`, so the parent names it. */
export function sandboxExecutor(
  images: {
    machine: string;
    imageOf: (repoPath: string) => Promise<string>;
    /** The list a check of this repository may reach (`egressPolicy`, kind `check`); absent, the check joins an ordinary bridge. */
    egress?: (repoPath: string | undefined) => Promise<{ allow: readonly string[]; allowPrivate: readonly string[]; proxyImage: string }>;
    /** The repository's own `sandbox.cpu` and `sandbox.memory_gb`; absent, the defaults. */
    limitsOf?: (repoPath: string | undefined) => Promise<SandboxSize>;
    /** The owner's store of this repository's scoped secrets; a check gets only the names it declares. */
    secrets?: SecretStore;
  },
  run: typeof execInSandbox = execInSandbox) {
  return async (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec>; repoPath?: string; secrets?: string[] } = {},
  ): Promise<ExecResult> => {
    if (!options.cwd) throw new Error("sandboxExecutor needs cwd: the worktree to mount");
    // The image is the repository's, named by the caller: never guessed from the folder. No repository, the machine's image.
    const image = options.repoPath ? await images.imageOf(options.repoPath) : images.machine;
    const env: Record<string, string> = {};
    const identity: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (typeof value !== "string") continue;
      if (key.startsWith("HARDNESS_")) env[key] = value;
      if (key.startsWith("GIT_AUTHOR_") || key.startsWith("GIT_COMMITTER_")) identity[key] = value;
    }
    const gitIdentity =
      identity.GIT_AUTHOR_NAME && identity.GIT_AUTHOR_EMAIL ? { name: identity.GIT_AUTHOR_NAME, email: identity.GIT_AUTHOR_EMAIL } : null;
    let secrets: Record<string, string> | undefined;
    if (options.secrets && options.secrets.length > 0) {
      if (!images.secrets || !options.repoPath) throw new SecretsMissingError(options.secrets.map((name) => ({ name, reason: "no secrets store is configured" })), "(no secrets store)");
      const loaded = await images.secrets.load(options.repoPath, options.secrets);
      if (loaded.missing.length > 0) throw new SecretsMissingError(loaded.missing, images.secrets.folder(options.repoPath));
      secrets = loaded.values;
    }
    return run(
      {
        ...(secrets ? { secrets } : {}),
        name: `hardness-check-${randomUUID().slice(0, 8)}`,
        image,
        worktree: options.cwd,
        ...(isFile(join(options.cwd, ".git")) ? { gitFile: join(options.cwd, ".git") } : {}),
        argv: [command, ...args],
        env,
        ...(images.egress ? { egress: await images.egress(options.repoPath) } : {}),
        ...(images.limitsOf ? { limits: await images.limitsOf(options.repoPath) } : {}),
        gitIdentity,
        services: options.services,
        cacheVolume: cacheVolumeFor(dirname(options.cwd)),
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
  };
}

/** A step declares a secret the owner's store does not hold: nothing ran. The detail names the secret and the folder, never a value. */
export class SecretsMissingError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(missing: ReadonlyArray<{ name: string; reason: string }>, folder: string) {
    const names = missing.map((m) => m.name);
    const reason = `the step declares secrets the machine cannot read: ${missing.map((m) => `${m.name} (${m.reason})`).join("; ")}; put each in ${folder}/<NAME> (mode 600)`;
    super(reason);
    this.name = "SecretsMissingError";
    this.detail = { escalation: "env_broken", envBroken: true, step: "secrets", names, reason, options: [`put the secret file(s) in ${folder}, then resume`] };
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

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

/** The id of a local image (`sha256:...`), the part of the environment a tag cannot pin; the tag itself when docker cannot say. */
export async function imageId(image: string): Promise<string> {
  const out = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const id = out.stdout.trim();
  return out.code === 0 && id ? id : image;
}

/** One label of a local image; null when the image or the label is not there. */
export async function imageLabel(image: string, label: string): Promise<string | null> {
  const out = await exec("docker", ["image", "inspect", "--format", `{{index .Config.Labels "${label}"}}`, image]);
  const value = out.stdout.trim();
  return out.code === 0 && value ? value : null;
}
