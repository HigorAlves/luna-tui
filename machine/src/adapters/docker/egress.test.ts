import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { GuardStartError } from "./guard.ts";
import { EgressUnsupportedError, cardNetworkArgs, egressBridgeArgs, ensureEgressBridge, openCardNetwork, proxyArgs, findCardNetwork, removeLeftoverNetworks, removeRunNetwork } from "./egress.ts";

const IMAGE = "machine-image:dev";
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

/** A docker fake: records every call; `answers` overrides a verb's reply by a predicate on the argument list. */
function dockerFake(answers: Array<(args: string[]) => ExecResult | undefined> = [], logs = '{"ready":{"port":3128}}\n') {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, ...args]);
    for (const answer of answers) {
      const r = answer(args);
      if (r) return r;
    }
    const key = args.slice(0, 2).join(" ");
    if (key === "network inspect" && args.some((a) => a.includes("Subnet"))) return ok("172.18.0.0/16\n");
    if (key === "network inspect" && args.includes("hardness-egress")) return ok("[]");
    if (args[0] === "version") return ok("29.9.2\n");
    if (key === "network inspect") return ok("true|isolated|invalid IP");
    if (args[0] === "inspect" && args.includes("hardness-guard-r1") && !args.join(" ").includes("IPAddress")) return fail("No such container");
    if (args[0] === "inspect" && args.join(" ").includes("IPAddress")) return ok(args.includes("hardness-guard-r1") ? "172.30.0.3\n" : "172.30.0.2\n");
    if (args[0] === "inspect") return ok("true");
    if (args[0] === "logs") return ok(logs);
    return ok();
  };
  return { calls, exec };
}
const verbs = (calls: string[][]) => calls.map((c) => c.slice(1, 3).join(" "));

describe("the network commands", () => {
  it("makes a card network internal, with no IPv6 and the isolated gateway mode, labelled like a stage container", () => {
    expect(cardNetworkArgs("hardness-card-r1")).toEqual(["network", "create", "--internal", "--ipv6=false", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--label", "dev.hardness.stage=1", "hardness-card-r1"]);
  });

  it("makes the egress bridge with no traffic between containers on it", () => {
    expect(egressBridgeArgs()).toEqual(["network", "create", "--ipv6=false", "-o", "com.docker.network.bridge.enable_icc=false", "--label", "dev.hardness.egress=1", "hardness-egress"]);
    expect(egressBridgeArgs("other")).toContain("other");
  });

  it("creates the bridge only when it is not there, and treats a lost race as there", async () => {
    const present = dockerFake();
    await ensureEgressBridge(present.exec, "hardness-egress");
    expect(verbs(present.calls)).toEqual(["network inspect"]);
    const absent = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" ? fail("No such network") : undefined)]);
    await ensureEgressBridge(absent.exec, "hardness-egress");
    expect(verbs(absent.calls)).toEqual(["network inspect", "network create"]);
    const raced = dockerFake([(a) => (a[1] === "inspect" ? fail("No such network") : a[1] === "create" ? fail("network with name hardness-egress already exists") : undefined)]);
    await expect(ensureEgressBridge(raced.exec, "hardness-egress")).resolves.toBeUndefined();
    const broken = dockerFake([(a) => (a[1] === "inspect" ? fail("No such network") : a[1] === "create" ? fail("Cannot connect to the Docker daemon") : undefined)]);
    await expect(ensureEgressBridge(broken.exec, "hardness-egress")).rejects.toThrow(/Docker daemon/);
  });
});

describe("the engine relay", () => {
  const relay = { kind: "oauth" as const, placeholder: "sk-ant-oat01-luna-relay-abc", file: "/state/runs/r1/relay/anthropic", metaFile: "/state/runs/r1/relay/meta.json" };

  it("starts the proxy with the credential and the placeholder as read-only file mounts, never as a value, and with the bridge's subnet to refuse", () => {
    const args = proxyArgs({ run: "r1", image: IMAGE, bridge: "hardness-egress", allow: [], allowPrivate: [], relay, relayDenyLocal: "172.18.0.0/16" });
    expect(args).toContain("/state/runs/r1/relay/anthropic:/run/relay/anthropic:ro");
    expect(args[args.indexOf("/state/runs/r1/relay/anthropic:/run/relay/anthropic:ro") - 1]).toBe("-v");
    expect(args).toContain("/state/runs/r1/relay/meta.json:/run/relay/meta.json:ro");
    const tail = args.slice(args.indexOf("--relay"));
    expect(tail).toEqual(["--relay", "anthropic=/run/relay/anthropic", "--relay-meta", "/run/relay/meta.json", "--relay-listen", "3129", "--relay-deny-local", "172.18.0.0/16"]);
    expect(args.join(" ")).not.toContain(relay.placeholder);
    expect(args).not.toContain("--relay-placeholder");
    expect(args).not.toContain("-e");
    expect(proxyArgs({ run: "r1", image: IMAGE, bridge: "b", allow: [], allowPrivate: [] })).not.toContain("--relay");
  });

  it("starts a proxy for a run whose list is empty but that has a relay, and points a container at it, with its address in NO_PROXY", async () => {
    const { calls, exec } = dockerFake();
    const net = await openCardNetwork("r1", { allow: [], allowPrivate: [], relay }, { exec, proxyImage: IMAGE, pollMs: 0 });
    expect(calls.some((c) => c[1] === "run")).toBe(true);
    const args = net.containerArgs(["luna-app"]);
    const env = Object.fromEntries(args.filter((_, i) => args[i - 1] === "-e").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as [string, string]));
    expect(env.ANTHROPIC_BASE_URL).toBe("http://172.30.0.2:3129");
    for (const name of ["NO_PROXY", "no_proxy"]) expect(env[name]).toBe("localhost,127.0.0.1,::1,luna-app,172.30.0.2");
    expect(args.join(" ")).not.toContain(relay.file);
  });

  it("reads the egress bridge's subnet before the proxy starts and hands it to the relay to refuse; no subnet, no proxy", async () => {
    const withSubnet = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" && a.includes("hardness-egress") && a.some((x) => x.includes("Subnet")) ? ok("172.18.0.0/16 \n") : undefined)]);
    await openCardNetwork("r1", { allow: [], allowPrivate: [], relay }, { exec: withSubnet.exec, proxyImage: IMAGE, pollMs: 0 });
    const run = withSubnet.calls.find((c) => c[1] === "run")!;
    expect(run.slice(run.indexOf("--relay-deny-local"))).toEqual(["--relay-deny-local", "172.18.0.0/16"]);
    const none = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" && a.some((x) => x.includes("Subnet")) ? ok("\n") : undefined)]);
    await expect(openCardNetwork("r1", { allow: [], allowPrivate: [], relay }, { exec: none.exec, proxyImage: IMAGE, pollMs: 0 })).rejects.toThrow(/subnet/);
    expect(none.calls.some((c) => c[1] === "run")).toBe(false);
  });

  it("sets no base URL when there is no relay", async () => {
    const { exec } = dockerFake();
    const net = await openCardNetwork("r1", { allow: ["github.com:443"], allowPrivate: [] }, { exec, proxyImage: IMAGE, pollMs: 0 });
    expect(net.containerArgs().join(" ")).not.toContain("ANTHROPIC_BASE_URL");
  });
});

describe("proxyArgs", () => {
  const args = proxyArgs({ run: "r1", image: IMAGE, bridge: "hardness-egress", allow: ["github.com:443", "a.example.com:443"], allowPrivate: [] });

  it("starts the proxy from the machine's image on the egress bridge, hardened, with the list on its command line", () => {
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--name"]);
    expect(args).toContain("hardness-egress-r1");
    for (const flag of ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5", "--user", "65534:65534", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--entrypoint", "/opt/luna/bin/node", "dev.hardness.stage=1"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--network") + 1]).toBe("hardness-egress");
    const image = args.indexOf(IMAGE);
    expect(args.slice(image + 1)).toEqual(["/opt/luna/egress/proxy.ts", "--listen", "3128", "--allow", "a.example.com:443,github.com:443", "--allow-private", ""]);
  });

  it("has no mount and no environment variable, so there is nothing of the machine's in it", () => {
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("--add-host");
  });

  it("adds the host alias only when a private entry names host.docker.internal", () => {
    const withHost = proxyArgs({ run: "r1", image: IMAGE, bridge: "hardness-egress", allow: [], allowPrivate: ["host.docker.internal:4318"] });
    expect(withHost).toEqual(expect.arrayContaining(["--add-host", "host.docker.internal:host-gateway"]));
    expect(withHost.slice(withHost.indexOf("--allow-private"))).toEqual(["--allow-private", "host.docker.internal:4318"]);
    expect(proxyArgs({ run: "r1", image: IMAGE, bridge: "b", allow: [], allowPrivate: ["other.example.com:4318"] })).not.toContain("--add-host");
  });
});

describe("openCardNetwork", () => {
  const spec = { allow: ["github.com:443"], allowPrivate: [] };

  it("makes the network, starts the proxy, joins it to the card network and reads its address there", async () => {
    const { calls, exec } = dockerFake();
    const net = await openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 });
    // the card network first (a daemon that cannot make it fails before anything else is made), then its check, then the bridge
    expect(verbs(calls)).toEqual(["version --format", "network create", "network inspect", "network inspect", "run -d", "network connect", "inspect -f", "logs --tail"]);
    expect(calls[1]).toEqual(["docker", ...cardNetworkArgs("hardness-card-r1")]);
    expect(calls[4]!.slice(1, 5)).toEqual(["run", "-d", "--name", "hardness-egress-r1"]);
    expect(calls[5]).toEqual(["docker", "network", "connect", "hardness-card-r1", "hardness-egress-r1"]);
    expect(net.name).toBe("hardness-card-r1");
  });

  it("gives a container the network, the proxy as its resolver and the proxy variables, with its aliases and the services in NO_PROXY", async () => {
    const { exec } = dockerFake();
    const net = await openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 });
    const args = net.containerArgs(["luna-app", "postgres"]);
    expect(args.slice(0, 4)).toEqual(["--network", "hardness-card-r1", "--dns", "172.30.0.2"]);
    const env = Object.fromEntries(args.filter((_, i) => args[i - 1] === "-e").map((e) => e.split("=") as [string, string]));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "YARN_HTTP_PROXY", "YARN_HTTPS_PROXY"]) expect(env[name], name).toBe("http://172.30.0.2:3128");
    for (const name of ["NO_PROXY", "no_proxy"]) expect(env[name]).toBe("localhost,127.0.0.1,::1,luna-app,postgres");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("starts no proxy for an empty list: the network, a dead resolver and no proxy variable", async () => {
    const { calls, exec } = dockerFake();
    const net = await openCardNetwork("r1", { allow: [], allowPrivate: [] }, { exec, proxyImage: IMAGE, pollMs: 0 });
    expect(calls.some((c) => c[1] === "run")).toBe(false);
    expect(net.containerArgs(["x"])).toEqual(["--network", "hardness-card-r1", "--dns", "127.0.0.1"]);
    expect(await net.blocked()).toEqual([]);
    await net.teardown();
    expect(calls.filter((c) => c[1] === "rm")).toEqual([]);
    expect(calls.at(-1)).toEqual(["docker", "network", "rm", "hardness-card-r1"]);
  });

  it("refuses with EgressUnsupportedError, naming Docker 28, when the daemon will not make the isolated network, and makes no other", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "network" && a[1] === "create" && a.includes("hardness-card-r1") ? fail("Error response from daemon: invalid value for com.docker.network.bridge.gateway_mode_ipv4: isolated") : undefined)]);
    const error = await openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressUnsupportedError);
    expect((error as Error).message).toMatch(/Docker Engine 28/);
    expect(calls.filter((c) => c[1] === "network" && c[2] === "create" && c.includes("hardness-card-r1"))).toHaveLength(1);
    expect(calls.some((c) => c[1] === "run")).toBe(false);
  });

  it("refuses before making anything when the daemon's own version is older than 28.0, whatever it would echo back", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "version" ? ok("27.5.1\n") : undefined)]);
    const error = await openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressUnsupportedError);
    expect((error as Error).message).toContain("27.5.1");
    expect(calls.some((c) => c[1] === "network")).toBe(false);
    const unreadable = dockerFake([(a) => (a[0] === "version" ? fail("daemon down") : undefined)]);
    await expect(openCardNetwork("r1", spec, { exec: unreadable.exec, proxyImage: IMAGE, pollMs: 0 })).rejects.toBeInstanceOf(EgressUnsupportedError);
    for (const ok28 of ["28.0.0", "28.3.1", "29.9.2", "30.0.0"]) {
      const f = dockerFake([(a) => (a[0] === "version" ? ok(`${ok28}\n`) : undefined)]);
      await expect(openCardNetwork("r1", { allow: [], allowPrivate: [] }, { exec: f.exec, proxyImage: IMAGE, pollMs: 0 })).resolves.toBeDefined();
    }
  });

  it("removes the network again, and refuses, when it has a gateway address on the host, even though the option was echoed back", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" && a.includes("hardness-card-r1") ? ok("true|isolated|172.20.0.1") : undefined)]);
    await expect(openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 })).rejects.toBeInstanceOf(EgressUnsupportedError);
    expect(calls.at(-1)).toEqual(["docker", "network", "rm", "hardness-card-r1"]);
  });

  it("removes the network again, and refuses, when the network it made is not internal and isolated", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" && a.includes("hardness-card-r1") ? ok("false|") : undefined)]);
    await expect(openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 })).rejects.toBeInstanceOf(EgressUnsupportedError);
    expect(calls.at(-1)).toEqual(["docker", "network", "rm", "hardness-card-r1"]);
  });

  it("tears everything down when the proxy does not come up, and says why", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "inspect" && a.join(" ").includes("State.Running") ? ok("false") : undefined)], "node: bad option\n");
    await expect(openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 })).rejects.toThrow(/proxy.*bad option/s);
    expect(calls.some((c) => c[1] === "rm" && c.includes("hardness-egress-r1"))).toBe(true);
    expect(calls.at(-1)).toEqual(["docker", "network", "rm", "hardness-card-r1"]);
  });

  it("removes the proxy, then the network, and is safe to call twice", async () => {
    const { calls, exec } = dockerFake();
    const net = await openCardNetwork("r1", spec, { exec, proxyImage: IMAGE, pollMs: 0 });
    const before = calls.length;
    await net.teardown();
    await net.teardown();
    expect(calls.slice(before)).toEqual([["docker", "rm", "-f", "hardness-egress-r1"], ["docker", "network", "rm", "hardness-card-r1"]]);
  });
});

describe("the stage guard", () => {
  const relay = { kind: "oauth" as const, placeholder: "sk-ant-oat01-luna-relay-abc", file: "/state/runs/r1/relay/anthropic", metaFile: "/state/runs/r1/relay/meta.json" };
  const guard = { mode: "block" as const, blockSeverity: "high" as const, journalDir: "/nonexistent-root/runs/r1/guard" };
  const envOf = (args: string[]) => Object.fromEntries(args.filter((_, i) => args[i - 1] === "-e").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as [string, string]));
  const open = (over: Parameters<typeof dockerFake>[0] = []) => {
    const f = dockerFake(over);
    // the journal folder is made on the host: a scratch one
    const dir = mkdtempSync(join(tmpdir(), "egress-guard-"));
    return { ...f, net: () => openCardNetwork("r1", { allow: [], allowPrivate: [], relay, guard: { ...guard, journalDir: join(dir, "guard") } }, { exec: f.exec, proxyImage: IMAGE, guardImage: "guard:dev", pollMs: 0 }) };
  };

  it("starts the guard after the proxy is ready and points the stage at it instead of the relay, keeping the proxy address in NO_PROXY", async () => {
    const { calls, net } = open();
    const opened = await net();
    const order = calls.map((c) => c[1] === "run" ? c[4] : c[1] === "exec" ? "probe" : null).filter(Boolean);
    expect(order).toEqual(["hardness-egress-r1", "hardness-guard-r1", "probe"]);
    const run = calls.find((c) => c[1] === "run" && c.includes("hardness-guard-r1"))!;
    expect(run).toContain("hardness-card-r1");
    expect(run.slice(run.indexOf("guard:dev") + 1, run.indexOf("guard:dev") + 3)).toEqual(["http://172.30.0.2:3129", "0.0.0.0:8787"]);
    const env = envOf(opened.containerArgs(["luna-app"]));
    expect(env.ANTHROPIC_BASE_URL).toBe("http://172.30.0.3:8787");
    for (const name of ["NO_PROXY", "no_proxy"]) expect(env[name]).toBe("localhost,127.0.0.1,::1,luna-app,172.30.0.2,172.30.0.3");
    expect(opened.guard).toEqual({ address: "172.30.0.3", port: 8787, journalPath: expect.stringMatching(/guard\/calls\.jsonl$/) });
  });

  it("hands the guard a judge through the proxy when the spec has one: the judge's flags, the proxy's address as its HTTP(S)_PROXY, and no judge flag otherwise", async () => {
    const judge = { url: "http://host.docker.internal:4319/v1", failClosed: true };
    const f = dockerFake();
    const dir = mkdtempSync(join(tmpdir(), "egress-guard-"));
    await openCardNetwork("r1", { allow: [], allowPrivate: ["host.docker.internal:4319"], relay, guard: { ...guard, journalDir: join(dir, "guard"), judge } }, { exec: f.exec, proxyImage: IMAGE, guardImage: "guard:dev", pollMs: 0 });
    const run = f.calls.find((c) => c[1] === "run" && c.includes("hardness-guard-r1"))!;
    expect(run.slice(run.indexOf("--judge-url"), run.indexOf("--judge-url") + 3)).toEqual(["--judge-url", "http://host.docker.internal:4319/v1", "--judge-fail-closed"]);
    const env = envOf(run);
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(env[name]).toBe("http://172.30.0.2:3128");
    expect(env.NO_PROXY).toBe("172.30.0.2");
    // The proxy is told about the judge's entry (it adds host.docker.internal to its hosts).
    expect(f.calls.find((c) => c[1] === "run" && c.includes("hardness-egress-r1"))).toContain("host.docker.internal:host-gateway");
    const g = open();
    await g.net();
    const plain = g.calls.find((c) => c[1] === "run" && c.includes("hardness-guard-r1"))!;
    expect(plain).not.toContain("--judge-url");
    expect(envOf(plain)).not.toHaveProperty("HTTP_PROXY");
  });

  it("starts no guard without a relay, or without a spec: the stage's base URL stays the relay's", async () => {
    const f = dockerFake();
    const noRelay = await openCardNetwork("r1", { allow: ["github.com:443"], allowPrivate: [], guard }, { exec: f.exec, proxyImage: IMAGE, guardImage: "guard:dev", pollMs: 0 });
    expect(f.calls.some((c) => c.includes("hardness-guard-r1"))).toBe(false);
    expect(noRelay.guard).toBeUndefined();
    const g = dockerFake();
    const noSpec = await openCardNetwork("r1", { allow: [], allowPrivate: [], relay }, { exec: g.exec, proxyImage: IMAGE, guardImage: "guard:dev", pollMs: 0 });
    expect(g.calls.some((c) => c.includes("hardness-guard-r1"))).toBe(false);
    expect(envOf(noSpec.containerArgs()).ANTHROPIC_BASE_URL).toBe("http://172.30.0.2:3129");
  });

  it("removes the guard before the card network, which it is attached to", async () => {
    const { calls, net } = open();
    const opened = await net();
    const before = calls.length;
    await opened.teardown();
    await opened.teardown();
    expect(calls.slice(before)).toEqual([["docker", "rm", "-f", "hardness-guard-r1"], ["docker", "rm", "-f", "hardness-egress-r1"], ["docker", "network", "rm", "hardness-card-r1"]]);
  });

  it("throws GuardStartError, and removes the guard, the proxy and the network, when the guard does not start", async () => {
    const { calls, net } = open([(a) => (a[0] === "run" && a.includes("hardness-guard-r1") ? fail("Unable to find image 'guard:dev' locally") : undefined)]);
    await expect(net()).rejects.toBeInstanceOf(GuardStartError);
    const rm = calls.filter((c) => c[1] === "rm" || (c[1] === "network" && c[2] === "rm")).map((c) => c.slice(1).join(" "));
    expect(rm.at(-1)).toBe("network rm hardness-card-r1");
    expect(rm).toContain("rm -f hardness-guard-r1");
    expect(rm).toContain("rm -f hardness-egress-r1");
  });

  it("refuses to start a guarded run with no guard image: it never falls back to an unguarded one", async () => {
    const f = dockerFake();
    await expect(openCardNetwork("r1", { allow: [], allowPrivate: [], relay, guard }, { exec: f.exec, proxyImage: IMAGE, pollMs: 0 })).rejects.toBeInstanceOf(GuardStartError);
    expect(f.calls.at(-1)).toEqual(["docker", "network", "rm", "hardness-card-r1"]);
  });

  it("is found again by a re-attached run, and removed first with the run", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "inspect" && a.includes("hardness-guard-r1") ? ok("true") : undefined)]);
    const net = await findCardNetwork("r1", exec);
    await net!.teardown();
    expect(calls.filter((c) => c[1] === "rm" || (c[1] === "network" && c[2] === "rm")).map((c) => c.slice(1).join(" "))).toEqual(["rm -f hardness-guard-r1", "rm -f hardness-egress-r1", "network rm hardness-card-r1"]);
  });

  it("sweeps a guard whose run is gone, before the networks, and leaves a live run's guard", async () => {
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push([command, ...args]);
      if (args[0] === "ps" && args.some((a) => a.includes("hardness-guard-"))) return ok("hardness-guard-dead\nhardness-guard-live\n");
      if (args[0] === "ps") return ok("");
      if (args[0] === "inspect" && args.includes("dead")) return fail("No such container");
      if (args[0] === "inspect") return ok("true");
      if (args[0] === "network" && args[1] === "ls") return ok("net-free\n");
      if (args[0] === "network" && args[1] === "inspect") return ok("0");
      return ok();
    };
    await removeLeftoverNetworks(exec);
    expect(calls).toContainEqual(["docker", "rm", "-f", "hardness-guard-dead"]);
    expect(calls).not.toContainEqual(["docker", "rm", "-f", "hardness-guard-live"]);
    expect(calls.findIndex((c) => c.join(" ") === "docker rm -f hardness-guard-dead")).toBeLessThan(calls.findIndex((c) => c.join(" ") === "docker network rm net-free"));
  });
});

describe("blocked()", () => {
  const line = (host: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ blocked: { host, port: 443, via: "connect", reason: "not_listed", ...extra } });

  async function rowsOf(logs: string) {
    const { exec } = dockerFake([], `{"ready":{"port":3128}}\n${logs}`);
    const net = await openCardNetwork("r1", { allow: ["github.com:443"], allowPrivate: [] }, { exec, proxyImage: IMAGE, pollMs: 0 });
    return net.blocked();
  }

  it("reads the proxy's log tail into rows, the last count of a key winning, and drops a line of any other shape", async () => {
    const rows = await rowsOf(
      [
        '{"ready":{"port":3128}}',
        line("evil.example.com"),
        line("evil.example.com", { count: 10 }),
        line("a.example.com", { via: "dns", port: 53 }),
        "not json at all",
        JSON.stringify({ blocked: { host: "x", port: "443", via: "connect", reason: "not_listed" } }),
        JSON.stringify({ blocked: { host: "x", port: 443, via: "carrier-pigeon", reason: "not_listed" } }),
        JSON.stringify({ blocked: { host: 7, port: 443, via: "connect", reason: "not_listed" } }),
        JSON.stringify({ blocked: { host: "y", port: 443, via: "connect", reason: "because" } }),
        JSON.stringify({ blocked: { host: "z", port: 443, via: "connect", reason: "not_listed", extra: 1 } }),
        JSON.stringify({ more: 5 }),
      ].join("\n"),
    );
    expect(rows).toEqual([
      { host: "evil.example.com", port: 443, via: "connect", reason: "not_listed", count: 10 },
      { host: "a.example.com", port: 53, via: "dns", reason: "not_listed", count: 1 },
    ]);
  });

  it("flattens a hostile host with safe() and cuts it at 253 characters", async () => {
    const rows = await rowsOf([line("<img src=x onerror=1>@a.example.com #12"), line("h".repeat(400))].join("\n"));
    expect(rows[0]!.host).not.toMatch(/[<>]/);
    expect(rows[0]!.host).not.toContain("@a");
    expect(rows[1]!.host).toHaveLength(253);
  });

  it("returns at most 50 rows", async () => {
    const rows = await rowsOf(Array.from({ length: 80 }, (_, i) => line(`h${i}.example.com`)).join("\n"));
    expect(rows).toHaveLength(50);
  });
});

describe("removeLeftoverNetworks", () => {
  it("removes a proxy whose run is gone, then every labelled network that no container uses", async () => {
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push([command, ...args]);
      if (args[0] === "ps") return ok("hardness-egress-dead\nhardness-egress-live\n");
      if (args[0] === "inspect" && args.includes("dead")) return fail("No such container");
      if (args[0] === "inspect") return ok("true");
      if (args[0] === "network" && args[1] === "ls") return ok("net-used\nnet-free\n");
      if (args[0] === "network" && args[1] === "inspect") return ok(args.includes("net-used") ? "1" : "0");
      return ok();
    };
    expect(await removeLeftoverNetworks(exec)).toBe(1);
    expect(calls).toContainEqual(["docker", "rm", "-f", "hardness-egress-dead"]);
    expect(calls).not.toContainEqual(["docker", "rm", "-f", "hardness-egress-live"]);
    expect(calls).toContainEqual(["docker", "network", "rm", "net-free"]);
    expect(calls).not.toContainEqual(["docker", "network", "rm", "net-used"]);
    expect(calls.find((c) => c[1] === "network" && c[2] === "ls")).toEqual(["docker", "network", "ls", "-q", "--filter", "label=dev.hardness.stage=1"]);
  });
});

describe("findCardNetwork", () => {
  it("finds a run's network and proxy by name, and reads and removes them", async () => {
    const { calls, exec } = dockerFake([], '{"blocked":{"host":"a.example.com","port":443,"via":"connect","reason":"not_listed"}}\n');
    const net = await findCardNetwork("r1", exec);
    expect(net).not.toBeNull();
    expect(net!.name).toBe("hardness-card-r1");
    expect(await net!.blocked()).toEqual([{ host: "a.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }]);
    await net!.teardown();
    await net!.teardown();
    expect(calls.filter((c) => c[1] === "rm")).toEqual([["docker", "rm", "-f", "hardness-egress-r1"]]);
    expect(calls.at(-1)).toEqual(["docker", "network", "rm", "hardness-card-r1"]);
  });


  it("has no proxy to read or remove when there is none", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "inspect" && a.includes("hardness-egress-r1") ? fail("No such container") : undefined)]);
    const net = await findCardNetwork("r1", exec);
    expect(await net!.blocked()).toEqual([]);
    await net!.teardown();
    expect(calls.filter((c) => c[1] === "rm")).toEqual([]);
  });
});

describe("removeRunNetwork", () => {
  it("removes a run's proxy and its card network by the run's container name, and is safe when they are gone", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "rm" || (a[0] === "network" && a[1] === "rm") ? fail("No such") : undefined)]);
    await removeRunNetwork("hardness-abcd1234-council-security-1", exec);
    expect(calls).toEqual([
      ["docker", "rm", "-f", "hardness-guard-hardness-abcd1234-council-security-1"],
      ["docker", "rm", "-f", "hardness-egress-hardness-abcd1234-council-security-1"],
      ["docker", "network", "rm", "hardness-card-hardness-abcd1234-council-security-1"],
    ]);
  });
});

describe("findCardNetwork when only the proxy is left", () => {
  it("still finds the proxy, so it is removed at the run's end", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" ? fail("No such network") : undefined)]);
    const net = await findCardNetwork("r1", exec);
    expect(net).not.toBeNull();
    await net!.teardown();
    expect(calls).toContainEqual(["docker", "rm", "-f", "hardness-egress-r1"]);
  });

  it("is null when neither the network nor the proxy is there", async () => {
    const { exec } = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" ? fail("No such network") : a[0] === "inspect" ? fail("No such container") : undefined)]);
    expect(await findCardNetwork("r1", exec)).toBeNull();
  });
});
