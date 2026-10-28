import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { ServiceNotReadyError, serviceArgs, serviceName, startServices } from "./services.ts";

const postgres = {
  image: "postgres:16",
  env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "app" },
  ready: "pg_isready -U app",
  exports: { DATABASE_URL: "postgres://app:app@postgres:5432/app" },
};

/** A docker fake: records every call; `ready` answers the readiness probes in order. */
function dockerFake(ready: number[] = [0]) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, ...args]);
    if (args[0] === "exec") return { code: ready.length > 1 ? ready.shift()! : ready[0]!, stdout: "", stderr: "" };
    if (args[0] === "logs") return { code: 0, stdout: "", stderr: "database system is starting up\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

describe("serviceArgs", () => {
  it("runs the service detached on the run's network, reachable by its key, labelled like a stage container", () => {
    expect(serviceArgs("hardness-net-r1", "r1", "postgres", postgres)).toEqual([
      "run", "-d", "--name", "r1-svc-postgres", "--label", "dev.hardness.stage=1", "--network", "hardness-net-r1", "--network-alias", "postgres",
      "-e", "POSTGRES_USER=app", "-e", "POSTGRES_PASSWORD=app", "postgres:16",
    ]);
    expect(serviceName("r1", "postgres")).toBe("r1-svc-postgres");
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
