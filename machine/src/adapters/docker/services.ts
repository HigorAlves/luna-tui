// The services a repo's luna.yaml declares (a database, a broker), run beside one stage or
// check container on a private network and torn down with it. Each task run gets its own,
// so two tasks of one repo never share state.
import type { ServiceSpec } from "@hardness/contracts";

import { type ExecResult, exec as hostExec } from "../process/exec.ts";

/** The same label stage containers carry (docker.ts), so leftovers are swept together. */
const CONTAINER_LABEL = "dev.hardness.stage";

/** How long a service gets to answer its ready line before the run is given up. */
export const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;
const LOG_TAIL = 40;

export class ServiceNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceNotReadyError";
  }
}

export interface ServiceSet {
  /** The docker network the run's container joins; null when there are no services. */
  network: string | null;
  /** What the services export, for the run's container. */
  env: Record<string, string>;
  /** Removes the services and the network; safe to call twice. */
  teardown(): Promise<void>;
}

export const networkName = (runName: string): string => `hardness-net-${runName}`;
export const serviceName = (runName: string, key: string): string => `${runName}-svc-${key}`;

/** The `docker run` argument list for one service. Pure. */
export function serviceArgs(network: string, runName: string, key: string, spec: ServiceSpec): string[] {
  const args = ["run", "-d", "--name", serviceName(runName, key), "--label", `${CONTAINER_LABEL}=1`, "--network", network, "--network-alias", key];
  for (const [name, value] of Object.entries(spec.env ?? {})) args.push("-e", `${name}=${value}`);
  args.push(spec.image);
  return args;
}

export interface StartOptions {
  exec?: (command: string, args: string[]) => Promise<ExecResult>;
  readyTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** Starts every service on a fresh network and waits until each one's `ready` line exits 0. */
export async function startServices(runName: string, services: Record<string, ServiceSpec>, options: StartOptions = {}): Promise<ServiceSet> {
  const exec = options.exec ?? hostExec;
  const keys = Object.keys(services);
  if (keys.length === 0) return { network: null, env: {}, teardown: async () => {} };
  const network = networkName(runName);
  let torn = false;
  const teardown = async () => {
    if (torn) return;
    torn = true;
    for (const key of keys) await exec("docker", ["rm", "-f", serviceName(runName, key)]);
    await exec("docker", ["network", "rm", network]);
  };
  const env: Record<string, string> = {};
  try {
    const created = await exec("docker", ["network", "create", network]);
    if (created.code !== 0) throw new ServiceNotReadyError(`network ${network}: ${created.stderr.trim() || "docker network create failed"}`);
    for (const key of keys) {
      const spec = services[key]!;
      const started = await exec("docker", serviceArgs(network, runName, key, spec));
      if (started.code !== 0) throw new ServiceNotReadyError(`service ${key} (${spec.image}) did not start: ${started.stderr.trim()}`);
      Object.assign(env, spec.exports ?? {});
    }
    for (const key of keys) await waitReady(runName, key, services[key]!, exec, options);
  } catch (error) {
    await teardown();
    throw error;
  }
  return { network, env, teardown };
}

async function waitReady(runName: string, key: string, spec: ServiceSpec, exec: NonNullable<StartOptions["exec"]>, options: StartOptions): Promise<void> {
  if (!spec.ready) return;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  const name = serviceName(runName, key);
  for (;;) {
    const probe = await exec("docker", ["exec", name, "sh", "-c", spec.ready]);
    if (probe.code === 0) return;
    if (now() >= deadline) {
      const logs = await exec("docker", ["logs", "--tail", String(LOG_TAIL), name]);
      const tail = `${logs.stdout}${logs.stderr}`.trim();
      throw new ServiceNotReadyError(`service ${key} (${spec.image}) not ready after ${options.readyTimeoutMs ?? READY_TIMEOUT_MS}ms: \`${spec.ready}\` kept failing${tail ? `\n${tail}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
  }
}
