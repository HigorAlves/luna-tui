// The stage guard: one container per run, between a Claude stage and the engine relay (RFC 0012, Track B). The stage holds the relay's
// placeholder and sends its model calls here; SafeAgents checks them and forwards to the relay, which swaps in the real token. The guard
// holds no secret, sits on the card network only (no route out: it reaches the relay and nothing else) and is removed with the run.
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GuardMode, Severity } from "@hardness/contracts";

import { safe } from "../../domain/evidence-markdown.ts";
import { type ExecResult, exec as hostExec } from "../process/exec.ts";

/** The same label as a stage container's and the proxy's, so leftovers are swept together. */
const STAGE_LABEL = "dev.hardness.stage=1";
export const GUARD_PORT = 8787;
/** Where the guard writes its journal (mounted read-write) and finds its secret files (mounted read-only; empty until a judge has a key). */
const JOURNAL_MOUNT = "/run/guard-journal";
const JOURNAL_FILE = "calls.jsonl";
const SECRETS_MOUNT = "/run/luna-secrets";
const FALLBACK_USER = "65534:65534";
const LOG_TAIL = 2000;

type DockerExec = (command: string, args: string[]) => Promise<ExecResult>;

/** Why an image is not the stage guard (no dev.hardness.guard label: wrong name, or never built), or null. `label` reads one label of a local image. */
export async function guardImageProblem(image: string, label: (image: string, name: string) => Promise<string | null>): Promise<string | null> {
  return (await label(image, "dev.hardness.guard")) === null ? `image ${image} is not the stage guard (label dev.hardness.guard): build it with pnpm images` : null;
}

/** Where a run's guard finds its secret files: beside its journal folder, in the run's private folder. */
export const guardSecretsDir = (journalDir: string): string => join(dirname(journalDir), "guard-secrets");

export const guardName = (run: string): string => `hardness-guard-${run}`;

/** The guard would not start or never listened: the stage must not run unguarded, so the card is escalated as env_broken. */
export class GuardStartError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`the stage guard did not start: ${reason}`);
    this.name = "GuardStartError";
    this.reason = reason;
  }
}

/** What a run asks of its guard: `log` records and passes, `block` replaces a call at or above the severity. The folder is where the journal goes (the machine makes it). */
export interface GuardSpec {
  mode: Exclude<GuardMode, "off">;
  blockSeverity: Severity;
  journalDir: string;
  /** The judge this run's guard asks (RFC 0012, B6): the machine's endpoint as the guard reaches it, and whether an error from it blocks. Absent, no judge flag. The run's key is a file in the guard's secrets folder, written by the caller before the guard starts. */
  judge?: { url: string; failClosed: boolean };
}

export interface GuardOptions {
  run: string;
  image: string;
  /** The run's card network, and the proxy's address on it (the guard's resolver). */
  network: string;
  dns: string;
  /** The host folders mounted: journal read-write, secrets read-only. */
  journalDir: string;
  secretsDir: string;
  /** The relay's URL: `http://<proxy address>:3129`. SafeAgents forwards to it, adding the request's path. */
  upstream: string;
  mode: Exclude<GuardMode, "off">;
  blockSeverity: Severity;
  /** The judge (RFC 0012 B6): its flags are added only when given. */
  judge?: { url: string; failClosed: boolean };
  /** The egress proxy's URL, for the guard's own outbound calls (a judge); absent, the guard has no proxy variables. */
  proxy?: string;
  /** `uid:gid` the guard runs as: the machine's user, so the 0600 journal is one the machine reads. */
  user?: string | undefined;
}

/** `docker run` for a run's guard. Pure: no credential in it, by name or by value. The relay's placeholder passes through the guard in a request header, never through its arguments. */
export function guardArgs(o: GuardOptions): string[] {
  const args = ["run", "-d", "--name", guardName(o.run), "--label", STAGE_LABEL, "--network", o.network, "--dns", o.dns];
  args.push("--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--ipc", "private", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m", "--cpus", "1", "--user", o.user ?? FALLBACK_USER);
  args.push("-v", `${o.journalDir}:${JOURNAL_MOUNT}`, "-v", `${o.secretsDir}:${SECRETS_MOUNT}:ro`);
  // The guard's own clients read these: the relay's address is exempt from the proxy (the NO_PROXY trap, RFC 0009), so the forward goes direct.
  const env: Array<[string, string]> = [["HOME", "/tmp"], ["NO_PROXY", o.dns], ["no_proxy", o.dns]];
  if (o.proxy) for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env.push([name, o.proxy]);
  for (const [name, value] of env) args.push("-e", `${name}=${value}`);
  // The image's entrypoint is `luna-env safeagents`: what follows is SafeAgents' own command line. A bare port would bind 127.0.0.1.
  args.push(o.image, o.upstream, `0.0.0.0:${GUARD_PORT}`, "--journal", `${JOURNAL_MOUNT}/${JOURNAL_FILE}`, "--block-severity", o.blockSeverity);
  if (o.mode === "log") args.push("--log-only");
  if (o.judge) args.push("--judge-url", o.judge.url, ...(o.judge.failClosed ? ["--judge-fail-closed"] : []));
  return args;
}

export interface RunningGuard {
  /** The guard's address on the card network, and its port. */
  address: string;
  port: number;
  /** Where the journal is on the host once the guard has written it. */
  journalPath: string;
  /** Removes the container; safe to call twice. */
  remove(): Promise<void>;
}

export interface StartGuardOptions extends GuardOptions {
  exec?: DockerExec;
  pollMs?: number;
  readyTimeoutMs?: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The socket is bound when a connection to it succeeds. The "listening" log line is printed before that, so it is not the signal. */
const PROBE = `import socket;socket.create_connection(('127.0.0.1',${GUARD_PORT}))`;

/** Starts a run's guard on its card network and waits until its port accepts a connection. A failed start or a timeout removes the half-started container and throws `GuardStartError`. */
export async function startGuard(options: StartGuardOptions): Promise<RunningGuard> {
  const exec = options.exec ?? hostExec;
  const name = guardName(options.run);
  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await exec("docker", ["rm", "-f", name]);
  };
  try {
    // The journal folder is the machine's, inside the run's private folder. The guard runs as the machine's own user, so the folder is the machine's alone (0700). Only a guard run as another
    // uid (no `user` given: the fallback is nobody; or a different one) needs it open to write the journal, and that is the one case that keeps 0777.
    await mkdir(options.journalDir, { recursive: true });
    const own = typeof process.getuid === "function" && options.user !== undefined && options.user.split(":")[0] === String(process.getuid());
    await chmod(options.journalDir, own ? 0o700 : 0o777);
    await mkdir(options.secretsDir, { recursive: true, mode: 0o755 });
    await chmod(options.secretsDir, 0o755);
  } catch (error) {
    throw new GuardStartError(`its folders could not be made: ${(error as Error).message}`);
  }
  try {
    const started = await exec("docker", guardArgs(options));
    if (started.code !== 0) throw new GuardStartError(safe(started.stderr.trim() || "docker run failed").slice(0, 400));
    const looked = await exec("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${options.network}").IPAddress}}`, name]);
    const address = looked.stdout.trim();
    if (looked.code !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new GuardStartError(`it has no address on ${options.network}`);
    const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
    for (;;) {
      if ((await exec("docker", ["exec", name, "python", "-c", PROBE])).code === 0) break;
      const running = await exec("docker", ["inspect", "-f", "{{.State.Running}}", name]);
      if (running.stdout.trim() !== "true" || Date.now() >= deadline) {
        const logs = await exec("docker", ["logs", "--tail", "50", name]);
        const text = safe(`${logs.stdout}${logs.stderr}`).slice(-LOG_TAIL);
        throw new GuardStartError(`${running.stdout.trim() === "true" ? "it never listened" : "it exited"}: ${text || "no output"}`.slice(0, 600));
      }
      await wait(options.pollMs ?? 200);
    }
    return { address, port: GUARD_PORT, journalPath: join(options.journalDir, JOURNAL_FILE), remove };
  } catch (error) {
    await remove().catch(() => {});
    throw error instanceof GuardStartError ? error : new GuardStartError((error as Error).message);
  }
}
