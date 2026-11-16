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
  /** Every name a container may reach a service by, with its address on the network: written to the container's /etc/hosts (`hostArgs`), because gVisor's netstack does not apply the redirects Docker's embedded DNS needs. */
  hosts: ServiceHost[];
  /** Removes the services and the network; safe to call twice. */
  teardown(): Promise<void>;
}

export interface ServiceHost {
  name: string;
  address: string;
}

const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Throws on a name that is not a plain host name or an address that is not an IPv4 literal: nothing else reaches `--add-host`. */
export function checkHost(host: ServiceHost): ServiceHost {
  if (!HOST_NAME.test(host.name)) throw new ServiceNotReadyError(`service name ${JSON.stringify(host.name)} is not a plain host name (letters, digits, dot, dash, underscore)`);
  if (!IPV4.test(host.address)) throw new ServiceNotReadyError(`service ${host.name}: address ${JSON.stringify(host.address)} is not an IPv4 literal`);
  return host;
}

/** The `--add-host` arguments for a container that joins the services. Pure. */
export function hostArgs(hosts: readonly ServiceHost[] | undefined): string[] {
  return (hosts ?? []).flatMap((host) => {
    const { name, address } = checkHost(host);
    return ["--add-host", `${name}:${address}`];
  });
}

export const networkName = (runName: string): string => `hardness-net-${runName}`;
export const serviceName = (runName: string, key: string): string => `${runName}-svc-${key}`;

/** Official images start as root and drop to their own user (postgres, redis), so the few capabilities that takes stay and the rest go.
 *  One `--cap-add` per capability: the daemon refuses a comma-joined list ("invalid CapAdd"), and no service would start. */
const SERVICE_CAPS = ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"];
const SERVICE_HARDENING = ["--security-opt", "no-new-privileges", "--cap-drop", "ALL", ...SERVICE_CAPS.flatMap((cap) => ["--cap-add", cap]), "--pids-limit", "512"];

/** What the machine policy adds to a service container: its process limit (at most 512), the seccomp profile it names, and the runtime for the card's trust (never runc). */
export interface ServiceHardening {
  pids?: number;
  seccomp?: string;
  runtime?: string;
  /** The bounded size of the container the services run beside: each service is capped at it (`--cpus`, `--memory`). */
  cpu?: number;
  memoryGb?: number;
}
const SERVICE_MAX_PIDS = 512;

/** The `docker run` argument list for one service. Pure. */
export function serviceArgs(network: string, runName: string, key: string, spec: ServiceSpec, dns?: string, harden: ServiceHardening = {}): string[] {
  const hardening = [...SERVICE_HARDENING];
  hardening[hardening.indexOf("--pids-limit") + 1] = String(Math.min(harden.pids ?? SERVICE_MAX_PIDS, SERVICE_MAX_PIDS));
  if (harden.seccomp) hardening.push("--security-opt", `seccomp=${harden.seccomp}`);
  if (harden.runtime) hardening.push("--runtime", harden.runtime);
  if (harden.memoryGb) hardening.push("--memory", `${harden.memoryGb}g`);
  if (harden.cpu) hardening.push("--cpus", `${harden.cpu}`);
  const args = ["run", "-d", "--name", serviceName(runName, key), "--label", `${CONTAINER_LABEL}=1`, ...hardening, "--network", network, ...(dns ? ["--dns", dns] : []), "--network-alias", key];
  for (const [name, value] of Object.entries(spec.env ?? {})) args.push("-e", `${name}=${value}`);
  args.push(spec.image);
  return args;
}

export interface StartOptions {
  /** A card network that already exists (adapters/docker/egress.ts): the services join it, with its resolver, and no network is made or removed here. */
  network?: { name: string; dns: string };
  exec?: (command: string, args: string[]) => Promise<ExecResult>;
  /** The machine policy's process limit, seccomp profile and runtime for these services. */
  harden?: ServiceHardening;
  readyTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** Starts every service on a fresh network and waits until each one's `ready` line exits 0. */
export async function startServices(runName: string, services: Record<string, ServiceSpec>, options: StartOptions = {}): Promise<ServiceSet> {
  const exec = options.exec ?? hostExec;
  const keys = Object.keys(services);
  if (keys.length === 0) return { network: null, env: {}, hosts: [], teardown: async () => {} };
  const given = options.network;
  const network = given?.name ?? networkName(runName);
  let torn = false;
  const teardown = async () => {
    if (torn) return;
    torn = true;
    for (const key of keys) await exec("docker", ["rm", "-f", serviceName(runName, key)]);
    if (!given) await exec("docker", ["network", "rm", network]);
  };
  const env: Record<string, string> = {};
  const hosts: ServiceHost[] = [];
  try {
    for (const key of keys) checkHost({ name: key, address: "0.0.0.0" });
    if (!given) {
      const created = await exec("docker", ["network", "create", network]);
      if (created.code !== 0) throw new ServiceNotReadyError(`network ${network}: ${created.stderr.trim() || "docker network create failed"}`);
    }
    for (const key of keys) {
      const spec = services[key]!;
      const started = await exec("docker", serviceArgs(network, runName, key, spec, given?.dns, options.harden));
      if (started.code !== 0) throw new ServiceNotReadyError(`service ${key} (${spec.image}) did not start: ${started.stderr.trim()}`);
      Object.assign(env, spec.exports ?? {});
    }
    for (const key of keys) await waitReady(runName, key, services[key]!, exec, options);
    for (const key of keys) {
      const container = serviceName(runName, key);
      const found = await exec("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`, container]);
      if (found.code !== 0) throw new ServiceNotReadyError(`service ${key}: could not read its address on ${network}: ${found.stderr.trim() || "docker inspect failed"}`);
      const address = found.stdout.trim();
      hosts.push(checkHost({ name: key, address }), checkHost({ name: container, address }));
    }
  } catch (error) {
    await teardown();
    throw error;
  }
  return { network, env, hosts, teardown };
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
