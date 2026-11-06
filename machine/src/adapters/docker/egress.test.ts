import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { EgressUnsupportedError, cardNetworkArgs, egressBridgeArgs, ensureEgressBridge, openCardNetwork, proxyArgs, findCardNetwork, removeLeftoverNetworks } from "./egress.ts";

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
    if (key === "network inspect" && args.includes("hardness-egress")) return ok("[]");
    if (key === "network inspect") return ok("true|isolated");
    if (args[0] === "inspect" && args.join(" ").includes("IPAddress")) return ok("172.30.0.2\n");
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
    expect(verbs(calls)).toEqual(["network create", "network inspect", "network inspect", "run -d", "network connect", "inspect -f", "logs --tail"]);
    expect(calls[0]).toEqual(["docker", ...cardNetworkArgs("hardness-card-r1")]);
    expect(calls[3]!.slice(1, 5)).toEqual(["run", "-d", "--name", "hardness-egress-r1"]);
    expect(calls[4]).toEqual(["docker", "network", "connect", "hardness-card-r1", "hardness-egress-r1"]);
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

  it("is null when there is no such network", async () => {
    const { exec } = dockerFake([(a) => (a[0] === "network" && a[1] === "inspect" ? fail("No such network") : undefined)]);
    expect(await findCardNetwork("r1", exec)).toBeNull();
  });

  it("has no proxy to read or remove when there is none", async () => {
    const { calls, exec } = dockerFake([(a) => (a[0] === "inspect" && a.includes("hardness-egress-r1") ? fail("No such container") : undefined)]);
    const net = await findCardNetwork("r1", exec);
    expect(await net!.blocked()).toEqual([]);
    await net!.teardown();
    expect(calls.filter((c) => c[1] === "rm")).toEqual([]);
  });
});
