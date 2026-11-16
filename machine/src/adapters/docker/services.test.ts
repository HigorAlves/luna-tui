import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { serviceHardeningOf } from "./docker.ts";
import { ServiceNotReadyError, hostArgs, serviceArgs, serviceName, startServices } from "./services.ts";

const postgres = {
  image: "postgres:16",
  env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "app" },
  ready: "pg_isready -U app",
  exports: { DATABASE_URL: "postgres://app:app@postgres:5432/app" },
};

/** A docker fake: records every call; `ready` answers the readiness probes in order. */
function dockerFake(ready: number[] = [0], addresses: Record<string, string> = {}) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, ...args]);
    if (args[0] === "exec") return { code: ready.length > 1 ? ready.shift()! : ready[0]!, stdout: "", stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: `${addresses[args.at(-1)!] ?? "172.30.0.5"}\n`, stderr: "" };
    if (args[0] === "logs") return { code: 0, stdout: "", stderr: "database system is starting up\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

describe("serviceArgs", () => {
  it("runs the service detached on the run's network, reachable by its key, labelled like a stage container", () => {
    expect(serviceArgs("hardness-net-r1", "r1", "postgres", postgres)).toEqual([
      "run", "-d", "--name", "r1-svc-postgres", "--label", "dev.hardness.stage=1",
      // Official images start as root and drop to their own user, so the few capabilities that takes stay; the rest go.
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--pids-limit", "512",
      "--network", "hardness-net-r1", "--network-alias", "postgres",
      "-e", "POSTGRES_USER=app", "-e", "POSTGRES_PASSWORD=app", "postgres:16",
    ]);
    expect(serviceName("r1", "postgres")).toBe("r1-svc-postgres");
  });
});

describe("serviceArgs hardening from the policy", () => {
  it("takes the process limit from the policy, never above 512", () => {
    const at = (args: string[]) => args[args.indexOf("--pids-limit") + 1];
    expect(at(serviceArgs("n", "r1", "postgres", postgres, undefined, { pids: 200 }))).toBe("200");
    expect(at(serviceArgs("n", "r1", "postgres", postgres, undefined, { pids: 4096 }))).toBe("512");
    expect(at(serviceArgs("n", "r1", "postgres", postgres))).toBe("512");
  });

  it("adds the seccomp profile and the runtime the policy names", () => {
    const args = serviceArgs("n", "r1", "postgres", postgres, undefined, { seccomp: "/etc/luna/s.json", runtime: "runsc" });
    expect(args).toEqual(expect.arrayContaining(["--security-opt", "seccomp=/etc/luna/s.json", "--runtime", "runsc"]));
    expect(serviceArgs("n", "r1", "postgres", postgres).join(" ")).not.toMatch(/seccomp|--runtime/);
  });

  it("caps each service at the bounded cpu and memory of the container it runs beside", () => {
    const args = serviceArgs("n", "r1", "postgres", postgres, undefined, { cpu: 2, memoryGb: 4 });
    expect(args[args.indexOf("--memory") + 1]).toBe("4g");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(serviceArgs("n", "r1", "postgres", postgres).join(" ")).not.toMatch(/--memory|--cpus/);
    expect(serviceHardeningOf({ cpu: 2, memoryGb: 4, pids: 200, cacheTrust: "trusted" })).toEqual({ cpu: 2, memoryGb: 4, pids: 200 });
  });

  it("passes the hardening to each service it starts", async () => {
    const { calls, exec } = dockerFake();
    await startServices("r1", { postgres }, { exec, harden: { runtime: "runsc" } });
    expect(calls[1]).toEqual(["docker", ...serviceArgs("hardness-net-r1", "r1", "postgres", postgres, undefined, { runtime: "runsc" })]);
  });
});

describe("startServices", () => {
  it("creates the network, starts each service, waits for its ready line, and hands back the exported env", async () => {
    const { calls, exec } = dockerFake([1, 1, 0]);
    const set = await startServices("r1", { postgres }, { exec, pollMs: 0 });
    expect(set.network).toBe("hardness-net-r1");
    expect(set.env).toEqual({ DATABASE_URL: "postgres://app:app@postgres:5432/app" });
    expect(calls[0]).toEqual(["docker", "network", "create", "hardness-net-r1"]);
    expect(calls[1]).toEqual(["docker", ...serviceArgs("hardness-net-r1", "r1", "postgres", postgres)]);
    expect(calls.filter((c) => c[1] === "exec")).toEqual(Array(3).fill(["docker", "exec", "r1-svc-postgres", "sh", "-c", "pg_isready -U app"]));
    await set.teardown();
    expect(calls.slice(-2)).toEqual([
      ["docker", "rm", "-f", "r1-svc-postgres"],
      ["docker", "network", "rm", "hardness-net-r1"],
    ]);
  });

  it("is nothing for a repo with no services: no network, no env, a teardown that does nothing", async () => {
    const { calls, exec } = dockerFake();
    const set = await startServices("r1", {}, { exec });
    expect(set).toMatchObject({ network: null, env: {} });
    await set.teardown();
    expect(calls).toEqual([]);
  });

  it("gives up after the ready budget, tears everything down, and says which service with its log tail", async () => {
    const { calls, exec } = dockerFake([1]);
    let now = 0;
    await expect(startServices("r1", { postgres }, { exec, pollMs: 0, readyTimeoutMs: 100, now: () => (now += 60) })).rejects.toThrow(ServiceNotReadyError);
    await expect(startServices("r1", { postgres }, { exec, pollMs: 0, readyTimeoutMs: 100, now: () => (now += 60) })).rejects.toThrow(
      /postgres.*not ready.*database system is starting up/s,
    );
    expect(calls.filter((c) => c[1] === "rm")).toHaveLength(2);
    expect(calls.filter((c) => c[1] === "network" && c[2] === "rm")).toHaveLength(2);
  });

  it("treats a service with no ready line as ready once it runs", async () => {
    const { calls, exec } = dockerFake();
    const set = await startServices("r1", { redis: { image: "redis:7", exports: { REDIS_URL: "redis://redis:6379" } } }, { exec });
    expect(set.env).toEqual({ REDIS_URL: "redis://redis:6379" });
    expect(calls.some((c) => c[1] === "exec")).toBe(false);
  });
});

describe("startServices on a card network it is given", () => {
  const given = { name: "hardness-card-r1", dns: "172.30.0.2" };
  it("starts the services on that network with its resolver, and neither creates nor removes a network", async () => {
    const { calls, exec } = dockerFake();
    const set = await startServices("r1", { postgres }, { exec, pollMs: 0, network: given });
    expect(set.network).toBe("hardness-card-r1");
    const run = calls.find((c) => c[1] === "run")!;
    expect(run).toEqual(expect.arrayContaining(["--network", "hardness-card-r1", "--dns", "172.30.0.2", "--network-alias", "postgres"]));
    await set.teardown();
    expect(calls.some((c) => c[1] === "network")).toBe(false);
    expect(calls.filter((c) => c[1] === "rm")).toEqual([["docker", "rm", "-f", "r1-svc-postgres"]]);
  });

  it("removes the services it started, and no network, when one does not come up", async () => {
    const { calls, exec } = dockerFake([1]);
    await expect(startServices("r1", { postgres: { ...postgres, ready: "false" } }, { exec, pollMs: 0, readyTimeoutMs: 0, network: given })).rejects.toThrow();
    expect(calls.some((c) => c[1] === "network")).toBe(false);
    expect(calls).toContainEqual(["docker", "rm", "-f", "r1-svc-postgres"]);
  });

  it("is what it was without one: its own network, made and removed", async () => {
    const { calls, exec } = dockerFake();
    const set = await startServices("r1", { postgres }, { exec, pollMs: 0 });
    await set.teardown();
    expect(calls.filter((c) => c[1] === "network").map((c) => c[2])).toEqual(["create", "rm"]);
  });
});

describe("startServices hosts", () => {
  it("reads each service's address on the network, as the alias and as the container name", async () => {
    const { calls, exec } = dockerFake([0], { "r1-svc-postgres": "172.30.0.7", "r1-svc-redis": "172.30.0.8" });
    const set = await startServices("r1", { postgres, redis: { image: "redis:7" } }, { exec, pollMs: 0 });
    expect(set.hosts).toEqual([
      { name: "postgres", address: "172.30.0.7" },
      { name: "r1-svc-postgres", address: "172.30.0.7" },
      { name: "redis", address: "172.30.0.8" },
      { name: "r1-svc-redis", address: "172.30.0.8" },
    ]);
    expect(calls).toContainEqual(["docker", "inspect", "-f", '{{(index .NetworkSettings.Networks "hardness-net-r1").IPAddress}}', "r1-svc-postgres"]);
  });

  it("asks for the address on the card network when one is given", async () => {
    const { calls, exec } = dockerFake();
    await startServices("r1", { postgres }, { exec, network: { name: "hardness-card-r1", dns: "172.30.0.2" } });
    expect(calls.find((c) => c[1] === "inspect")![3]).toContain('"hardness-card-r1"');
  });

  it("has none for a repo with no services", async () => {
    const { exec } = dockerFake();
    expect((await startServices("r1", {}, { exec })).hosts).toEqual([]);
  });

  it("refuses an address that is not an IPv4 literal, and tears the run down", async () => {
    const { calls, exec } = dockerFake([0], { "r1-svc-postgres": "--privileged" });
    await expect(startServices("r1", { postgres }, { exec })).rejects.toThrow(/address/);
    expect(calls).toContainEqual(["docker", "rm", "-f", "r1-svc-postgres"]);
  });

  it("refuses a service name that could pass for an argument", async () => {
    const { exec } = dockerFake();
    await expect(startServices("r1", { "--privileged": { image: "x" } }, { exec })).rejects.toThrow(/name/);
  });
});

describe("hostArgs", () => {
  it("is one --add-host per name and address", () => {
    expect(hostArgs([{ name: "postgres", address: "172.30.0.7" }])).toEqual(["--add-host", "postgres:172.30.0.7"]);
    expect(hostArgs([])).toEqual([]);
    expect(hostArgs(undefined)).toEqual([]);
  });

  it("refuses a bad name or address", () => {
    expect(() => hostArgs([{ name: "--privileged", address: "172.30.0.7" }])).toThrow(/name/);
    expect(() => hostArgs([{ name: "a:b", address: "172.30.0.7" }])).toThrow(/name/);
    expect(() => hostArgs([{ name: "db", address: "172.30.0.7,evil" }])).toThrow(/address/);
    expect(() => hostArgs([{ name: "db", address: "999.1.1.1" }])).toThrow(/address/);
    expect(() => hostArgs([{ name: "db", address: "::1" }])).toThrow(/address/);
  });
});
