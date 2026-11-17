import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { GuardStartError, guardArgs, guardName, startGuard } from "./guard.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

const PLACEHOLDER = "sk-ant-oat01-luna-relay-abc";
const base = { run: "r1", image: "guard:dev", network: "hardness-card-r1", dns: "172.30.0.2", journalDir: "/state/runs/r1/guard", secretsDir: "/state/runs/r1/guard-secrets", upstream: "http://172.30.0.2:3129", mode: "block" as const, blockSeverity: "high" as const, user: "1000:1000" };

/** The values of every `-e NAME=value` in an argument list. */
const envOf = (args: string[]) => Object.fromEntries(args.filter((_, i) => args[i - 1] === "-e").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as [string, string]));

describe("guardArgs", () => {
  const args = guardArgs(base);

  it("hardens the guard, mounts only its journal and secret folders, and gives it no credential", () => {
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--name"]);
    expect(args).toContain("hardness-guard-r1");
    expect(guardName("r1")).toBe("hardness-guard-r1");
    for (const flag of ["--read-only", "--cap-drop", "ALL", "--ipc", "private", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m", "--cpus", "1", "dev.hardness.stage=1"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp");
    expect(args[args.indexOf("--network") + 1]).toBe("hardness-card-r1");
    expect(args[args.indexOf("--dns") + 1]).toBe("172.30.0.2");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--runtime");

    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toEqual(["/state/runs/r1/guard:/run/guard-journal", "/state/runs/r1/guard-secrets:/run/luna-secrets:ro"]);

    const env = envOf(args);
    expect(env.NO_PROXY).toBe("172.30.0.2");
    expect(Object.keys(env).filter((name) => /proxy/i.test(name)).sort()).toEqual(["NO_PROXY", "no_proxy"]);
    for (const [name, value] of Object.entries(env)) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|AUTH|ANTHROPIC/i);
      expect(value).not.toContain(PLACEHOLDER);
    }
    expect(args.join(" ")).not.toContain(PLACEHOLDER);

    const image = args.indexOf("guard:dev");
    expect(args.slice(image + 1)).toEqual(["http://172.30.0.2:3129", "0.0.0.0:8787", "--journal", "/run/guard-journal/calls.jsonl", "--block-severity", "high"]);
  });

  it("adds --log-only exactly when the mode is log", () => {
    expect(guardArgs({ ...base, mode: "log" }).slice(-1)).toEqual(["--log-only"]);
    expect(guardArgs({ ...base, mode: "block" })).not.toContain("--log-only");
    expect(guardArgs({ ...base, blockSeverity: "critical" })).toContain("critical");
  });

  it("falls back to an unprivileged user when the machine has none to give", () => {
    const { user: _user, ...without } = base;
    expect(guardArgs(without)[guardArgs(without).indexOf("--user") + 1]).toBe("65534:65534");
  });

  it("adds the judge's flags only when there is a judge, and the proxy variables only when a proxy is given", () => {
    expect(args).not.toContain("--judge-url");
    expect(args).not.toContain("--judge-fail-closed");
    const judged = guardArgs({ ...base, judge: { url: "http://host.docker.internal:9000/judge", failClosed: true }, proxy: "http://172.30.0.2:3128" });
    expect(judged.slice(judged.indexOf("--judge-url"))).toEqual(["--judge-url", "http://host.docker.internal:9000/judge", "--judge-fail-closed"]);
    expect(envOf(judged).HTTPS_PROXY).toBe("http://172.30.0.2:3128");
    expect(envOf(judged).http_proxy).toBe("http://172.30.0.2:3128");
    expect(guardArgs({ ...base, judge: { url: "http://j", failClosed: false } })).not.toContain("--judge-fail-closed");
  });
});

describe("startGuard", () => {
  const folder = mkdtempSync(join(tmpdir(), "guard-"));
  const options = (over: Record<string, unknown> = {}) => ({ ...base, journalDir: join(folder, "guard"), secretsDir: join(folder, "guard-secrets"), pollMs: 0, ...over });

  /** A docker fake: `exec` answers the probe by the script; every call is recorded. */
  function fake(probe: (n: number) => ExecResult, over: Array<(args: string[]) => ExecResult | undefined> = []) {
    const calls: string[][] = [];
    let probes = 0;
    const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
      calls.push(args);
      for (const answer of over) {
        const r = answer(args);
        if (r) return r;
      }
      if (args[0] === "exec") return probe(++probes);
      if (args[0] === "inspect" && args.join(" ").includes("IPAddress")) return ok("172.30.0.3\n");
      if (args[0] === "inspect") return ok("true");
      if (args[0] === "logs") return ok('{"event":"listening"}\n');
      return ok();
    };
    return { calls, exec, probes: () => probes };
  }

  it("waits for the socket to accept a connection, not for the log line", async () => {
    const { calls, exec, probes } = fake((n) => (n < 3 ? fail("ConnectionRefusedError") : ok()));
    const guard = await startGuard(options({ exec }));
    expect(probes()).toBe(3);
    const probe = calls.find((c) => c[0] === "exec")!;
    expect(probe.slice(0, 4)).toEqual(["exec", "hardness-guard-r1", "python", "-c"]);
    expect(probe[4]).toContain("socket.create_connection(('127.0.0.1',8787))");
    // The log line was there from the first poll; it did not end the wait.
    expect(calls.filter((c) => c[0] === "logs")).toHaveLength(0);
    expect(guard).toMatchObject({ address: "172.30.0.3", port: 8787, journalPath: join(folder, "guard", "calls.jsonl") });
    // The guard runs as another uid ("1000:1000" is not the test's user): it needs the folder open to write the journal.
    expect(statSync(join(folder, "guard")).mode & 0o777).toBe(0o777);
  });

  it("makes the journal folder the machine's alone (0700) when the guard runs as the machine's own user", async () => {
    if (typeof process.getuid !== "function") return;
    const { exec } = fake(() => ok());
    await startGuard(options({ exec, user: `${process.getuid()}:${process.getgid?.() ?? 0}` }));
    expect(statSync(join(folder, "guard")).mode & 0o777).toBe(0o700);
  });

  it("removes the container when asked, once", async () => {
    const { calls, exec } = fake(() => ok());
    const guard = await startGuard(options({ exec }));
    await guard.remove();
    await guard.remove();
    expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", "hardness-guard-r1"]]);
  });

  it("throws GuardStartError with the reason and removes the container when docker run fails", async () => {
    const { calls, exec } = fake(() => ok(), [(a) => (a[0] === "run" ? fail("Unable to find image 'guard:dev' locally") : undefined)]);
    await expect(startGuard(options({ exec }))).rejects.toMatchObject({ name: "GuardStartError", reason: expect.stringContaining("Unable to find image") });
    expect(calls).toContainEqual(["rm", "-f", "hardness-guard-r1"]);
  });

  it("throws GuardStartError with the log tail when the guard exits before it listens", async () => {
    const { calls, exec } = fake(() => fail("no"), [(a) => (a[0] === "inspect" && a.includes("{{.State.Running}}") ? ok("false") : undefined), (a) => (a[0] === "logs" ? ok("Traceback: boom") : undefined)]);
    const error = await startGuard(options({ exec })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardStartError);
    expect((error as GuardStartError).reason).toMatch(/exited.*boom/);
    expect(calls).toContainEqual(["rm", "-f", "hardness-guard-r1"]);
  });

  it("times out when the port never opens, and removes the half-started container", async () => {
    const { calls, exec } = fake(() => fail("refused"));
    await expect(startGuard(options({ exec, readyTimeoutMs: 20, pollMs: 5 }))).rejects.toThrow(/never listened/);
    expect(calls).toContainEqual(["rm", "-f", "hardness-guard-r1"]);
  });
});
