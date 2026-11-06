// A run's network, and the proxy that is its only door. The card network is `--internal` with the isolated gateway
// mode: no route out and no gateway address on the host. The proxy is a second container of the machine's own image,
// on that network and on one ordinary bridge the machine owns, started with the run's list on its command line, so
// nothing in a stage container can change it. See docs/architecture.md "A sandbox's network".
import { z } from "zod";

import { safe } from "../../domain/evidence-markdown.ts";
import { type ExecResult, exec as hostExec } from "../process/exec.ts";

/** Label on the card network and the proxy, the same as a stage container's, so leftovers are swept together. */
const STAGE_LABEL = "dev.hardness.stage=1";
export const EGRESS_BRIDGE = "hardness-egress";
const ISOLATED = "com.docker.network.bridge.gateway_mode_ipv4";
export const PROXY_PORT = 3128;
const PROXY_PROGRAM = "/opt/luna/bin/node";
const PROXY_FILE = "/opt/luna/egress/proxy.ts";
const LOG_TAIL = 2000;
export const MAX_BLOCKED_ROWS = 50;
const MAX_HOST = 253;

export type DockerExec = (command: string, args: string[]) => Promise<ExecResult>;

/** The daemon cannot make the isolated network: no fallback to a weaker one, the card is escalated as env_broken. */
export class EgressUnsupportedError extends Error {
  constructor(detail: string) {
    super(`this Docker daemon cannot make an isolated network (${detail}); the sandbox's network needs Docker Engine 28.0 or newer (gateway mode "isolated", added in 28.0.0), or set MACHINE_EGRESS=off on the machine to run without the allow-list`);
    this.name = "EgressUnsupportedError";
  }
}

export const cardNetworkName = (run: string): string => `hardness-card-${run}`;
export const proxyName = (run: string): string => `hardness-egress-${run}`;

/** `docker network create` for a run's card network. Pure. */
export const cardNetworkArgs = (name: string): string[] => ["network", "create", "--internal", "--ipv6=false", "-o", `${ISOLATED}=isolated`, "--label", STAGE_LABEL, name];

/** `docker network create` for the machine's egress bridge: containers on it cannot talk to each other. Pure. */
export const egressBridgeArgs = (name: string = EGRESS_BRIDGE): string[] => ["network", "create", "--ipv6=false", "-o", "com.docker.network.bridge.enable_icc=false", "--label", "dev.hardness.egress=1", name];

/** Makes the egress bridge when it is not there; two runs racing to make it is fine. */
export async function ensureEgressBridge(exec: DockerExec = hostExec, name: string = EGRESS_BRIDGE): Promise<void> {
  if ((await exec("docker", ["network", "inspect", name])).code === 0) return;
  const made = await exec("docker", egressBridgeArgs(name));
  if (made.code !== 0 && !/already exists/i.test(made.stderr)) throw new Error(`could not make the egress network ${name}: ${made.stderr.trim()}`);
}

export interface ProxyOptions {
  run: string;
  /** The machine's own image, never a repository's. */
  image: string;
  bridge: string;
  allow: readonly string[];
  allowPrivate: readonly string[];
}

/** `docker run` for a run's proxy. Pure: no mount and no variable, the list is its command line. */
export function proxyArgs(options: ProxyOptions): string[] {
  const args = ["run", "-d", "--name", proxyName(options.run), "--label", STAGE_LABEL, "--network", options.bridge];
  args.push("--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5", "--user", "65534:65534");
  args.push("--sysctl", "net.ipv4.ip_unprivileged_port_start=0");
  if (options.allowPrivate.some((entry) => entry.startsWith("host.docker.internal:"))) args.push("--add-host", "host.docker.internal:host-gateway");
  args.push("--entrypoint", PROXY_PROGRAM, options.image, PROXY_FILE, "--listen", String(PROXY_PORT), "--allow", [...options.allow].sort().join(","), "--allow-private", [...options.allowPrivate].sort().join(","));
  return args;
}

/** What the proxy refused, one row per (host, port, via). The host is untrusted text, flattened. */
export interface BlockedRow {
  host: string;
  port: number;
  via: "connect" | "http" | "dns";
  reason: string;
  count: number;
}

const ProxyLine = z.object({
  blocked: z.object({
    host: z.string(),
    port: z.number().int().min(0).max(65535),
    via: z.enum(["connect", "http", "dns"]),
    reason: z.enum(["not_listed", "address", "private_address", "sni_mismatch", "unresolved", "head_too_large"]),
    count: z.number().int().min(1).optional(),
  }).strict(),
}).strict();

/** The rows of a proxy's log text: a line that is not the expected JSON shape is dropped, the last count of a key wins, at most 50 rows. */
export function blockedRowsOf(text: string): BlockedRow[] {
  const rows = new Map<string, BlockedRow>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || line.length > 2048) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = ProxyLine.safeParse(json);
    if (!parsed.success) continue;
    const { host: raw, port, via, reason, count } = parsed.data.blocked;
    const host = safe(raw).slice(0, MAX_HOST);
    const key = `${via}|${host}|${port}`;
    const before = rows.get(key);
    rows.set(key, { host, port, via, reason, count: Math.max(count ?? 1, before?.count ?? 1) });
  }
  return [...rows.values()].slice(0, MAX_BLOCKED_ROWS);
}

export interface CardNetwork {
  name: string;
  /** The address of the proxy on this network (its refusing resolver too), or 127.0.0.1 when there is none. */
  dns: string;
  /** The `docker run` arguments that put a container on this network: `--network`, `--dns`, and the proxy variables when there is a proxy. */
  containerArgs(aliases?: string[]): string[];
  /** What the proxy refused so far. */
  blocked(): Promise<BlockedRow[]>;
  /** Removes the proxy and the network; safe to call twice. */
  teardown(): Promise<void>;
}

export interface OpenOptions {
  exec?: DockerExec;
  /** The machine's own runner image, where the proxy file is. */
  proxyImage: string;
  bridge?: string;
  pollMs?: number;
  readyTimeoutMs?: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes a run's card network and, when its list has an entry, the proxy on it. Throws `EgressUnsupportedError` when the daemon cannot make the isolated network. */
export async function openCardNetwork(runName: string, spec: { allow: readonly string[]; allowPrivate: readonly string[] }, options: OpenOptions): Promise<CardNetwork> {
  const exec = options.exec ?? hostExec;
  const bridge = options.bridge ?? EGRESS_BRIDGE;
  const network = cardNetworkName(runName);
  const proxy = proxyName(runName);
  const hasProxy = spec.allow.length + spec.allowPrivate.length > 0;
  let torn = false;
  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    if (hasProxy) await exec("docker", ["rm", "-f", proxy]);
    await exec("docker", ["network", "rm", network]);
  };

  // What the daemon does is what counts, not the option it echoes back: an engine older than 28.0 may accept `isolated` and ignore it.
  const version = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
  const parsed = /^(\d+)\.(\d+)/.exec(version.stdout.trim());
  if (version.code !== 0 || !parsed) throw new EgressUnsupportedError("the daemon's version could not be read");
  if (Number(parsed[1]) < 28) throw new EgressUnsupportedError(`the daemon is version ${version.stdout.trim()}`);
  const made = await exec("docker", cardNetworkArgs(network));
  if (made.code !== 0) {
    const why = made.stderr.trim() || "docker network create failed";
    if (/gateway_mode|isolated|unknown option|unsupported|invalid (value|option)|not supported/i.test(why)) throw new EgressUnsupportedError(why.split("\n")[0]!.slice(0, 200));
    throw new Error(`network ${network}: ${why}`);
  }
  try {
    // What was made must be what was asked for: an older daemon that ignored the option must not leave a network with a gateway.
    // ... and the network must have no gateway address on the host (Docker shows an isolated network's as `invalid IP`).
    const checked = await exec("docker", ["network", "inspect", "--format", `{{.Internal}}|{{index .Options "${ISOLATED}"}}|{{range .IPAM.Config}}{{.Gateway}}{{end}}`, network]);
    const [internal, mode, gateway = ""] = checked.stdout.trim().split("|");
    if (checked.code !== 0 || internal !== "true" || mode !== "isolated" || (gateway !== "" && gateway !== "invalid IP")) throw new EgressUnsupportedError(`the network came back as "${(checked.stdout.trim() || checked.stderr.trim()).slice(0, 80)}"`);

    let address = "127.0.0.1";
    if (hasProxy) {
      await ensureEgressBridge(exec, bridge);
      const started = await exec("docker", proxyArgs({ run: runName, image: options.proxyImage, bridge, allow: spec.allow, allowPrivate: spec.allowPrivate }));
      if (started.code !== 0) throw new Error(`egress proxy ${proxy} did not start: ${started.stderr.trim()}`);
      const joined = await exec("docker", ["network", "connect", network, proxy]);
      if (joined.code !== 0) throw new Error(`egress proxy ${proxy} could not join ${network}: ${joined.stderr.trim()}`);
      const looked = await exec("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, proxy]);
      address = looked.stdout.trim();
      if (looked.code !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new Error(`egress proxy ${proxy} has no address on ${network}`);
      await waitReady(exec, proxy, options);
    }

    const proxyUrl = `http://${address}:${PROXY_PORT}`;
    return {
      name: network,
      dns: address,
      containerArgs(aliases = []) {
        const args = ["--network", network, "--dns", address];
        if (!hasProxy) return args;
        const noProxy = ["localhost", "127.0.0.1", "::1", ...aliases].join(",");
        const env: Array<[string, string]> = [
          ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "YARN_HTTP_PROXY", "YARN_HTTPS_PROXY"].map((name): [string, string] => [name, proxyUrl]),
          ["NO_PROXY", noProxy],
          ["no_proxy", noProxy],
          ["NODE_USE_ENV_PROXY", "1"],
        ];
        return [...args, ...env.flatMap(([name, value]) => ["-e", `${name}=${value}`])];
      },
      async blocked() {
        if (!hasProxy || torn) return [];
        const logs = await exec("docker", ["logs", "--tail", String(LOG_TAIL), proxy]);
        return logs.code === 0 ? blockedRowsOf(`${logs.stdout}\n${logs.stderr}`) : [];
      },
      teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** A re-attached run's network and proxy, found by name (a restart found the container still running); null when the network is gone. The handle reads and removes them; it cannot put a container on the network. */
export async function findCardNetwork(runName: string, exec: DockerExec = hostExec): Promise<CardNetwork | null> {
  const network = cardNetworkName(runName);
  const proxy = proxyName(runName);
  if ((await exec("docker", ["network", "inspect", network])).code !== 0) return null;
  const hasProxy = (await exec("docker", ["inspect", "-f", "{{.State.Running}}", proxy])).code === 0;
  let torn = false;
  return {
    name: network,
    dns: "",
    containerArgs: () => {
      throw new Error("a re-attached network only reads and removes");
    },
    async blocked() {
      if (!hasProxy || torn) return [];
      const logs = await exec("docker", ["logs", "--tail", String(LOG_TAIL), proxy]);
      return logs.code === 0 ? blockedRowsOf(`${logs.stdout}\n${logs.stderr}`) : [];
    },
    async teardown() {
      if (torn) return;
      torn = true;
      if (hasProxy) await exec("docker", ["rm", "-f", proxy]);
      await exec("docker", ["network", "rm", network]);
    },
  };
}

/** Waits until the proxy says it listens; fails with its output when it exits or never does. */
async function waitReady(exec: DockerExec, proxy: string, options: OpenOptions): Promise<void> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
  for (;;) {
    const logs = await exec("docker", ["logs", "--tail", "50", proxy]);
    const text = `${logs.stdout}${logs.stderr}`;
    if (/"ready"\s*:/.test(text)) return;
    const running = await exec("docker", ["inspect", "-f", "{{.State.Running}}", proxy]);
    if (running.stdout.trim() !== "true" || Date.now() >= deadline) throw new Error(`egress proxy ${proxy} did not come up: ${safe(text).slice(0, 400) || "no output"}`);
    await wait(options.pollMs ?? 200);
  }
}

/** Removes proxies whose run's container is gone, then every network labelled as a stage's that no container uses. Returns how many networks went. */
export async function removeLeftoverNetworks(exec: DockerExec = hostExec): Promise<number> {
  const proxies = await exec("docker", ["ps", "--format", "{{.Names}}", "--filter", "name=^hardness-egress-"]);
  for (const name of proxies.stdout.split("\n").map((n) => n.trim()).filter((n) => n.startsWith("hardness-egress-"))) {
    const run = name.slice("hardness-egress-".length);
    const alive = await exec("docker", ["inspect", "-f", "{{.State.Running}}", run]);
    if (alive.code !== 0 || alive.stdout.trim() !== "true") await exec("docker", ["rm", "-f", name]);
  }
  const listed = await exec("docker", ["network", "ls", "-q", "--filter", `label=${STAGE_LABEL}`]);
  let removed = 0;
  for (const id of listed.stdout.split("\n").map((n) => n.trim()).filter(Boolean)) {
    const used = await exec("docker", ["network", "inspect", "--format", "{{len .Containers}}", id]);
    if (used.code === 0 && used.stdout.trim() === "0" && (await exec("docker", ["network", "rm", id])).code === 0) removed += 1;
  }
  return removed;
}
