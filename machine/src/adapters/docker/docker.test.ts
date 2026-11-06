import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { CACHE_ENV, type RunDeps, cacheVolumeFor, execInSandbox, runSandbox, sandboxArgs, sandboxExecArgs, sandboxExecutor, type SandboxRun } from "./docker.ts";
import { EgressUnsupportedError } from "./egress.ts";

function run(over: Partial<SandboxRun> = {}): SandboxRun {
  return {
    name: "c1",
    image: "img:1",
    runDir: "/state/runs/r1",
    worktree: "/wt",
    writable: false,
    gitDir: null,
    input: {},
    timeoutMs: 1000,
    credential: { env: { ANTHROPIC_API_KEY: "sk-secret-value" }, mounts: [] },
    labels: { "dev.hardness.task": "t1" },
    ...over,
  };
}

describe("sandboxArgs", () => {
  it("hardens the container and points HOME, TMPDIR and the SDK's config dir at the tmpfs", () => {
    const args = sandboxArgs(run(), "/state/runs/r1/in", "/state/runs/r1/out");
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges"]));
    for (const env of ["HOME=/tmp", "TMPDIR=/tmp", "CLAUDE_CONFIG_DIR=/tmp/claude"]) {
      expect(args.join(" ")).toContain(`-e ${env}`);
    }
  });

  it("passes the trace context in and adds the host alias only for a trace backend on host.docker.internal", () => {
    const traced = sandboxArgs(run({ extraEnv: { LMNR_BASE_URL: "http://host.docker.internal", LMNR_SPAN_CONTEXT: "c" } }), "/in", "/out");
    expect(traced).toEqual(expect.arrayContaining(["-e", "LMNR_BASE_URL=http://host.docker.internal", "--add-host", "host.docker.internal:host-gateway"]));
    expect(sandboxArgs(run({ extraEnv: { LMNR_BASE_URL: "http://lmnr-app" } }), "/in", "/out")).not.toContain("--add-host");
    expect(sandboxArgs(run(), "/in", "/out")).not.toContain("--add-host");
    // A repo's service exports (luna.yaml) never override the trace address: the extra env comes last.
    const both = sandboxArgs(run({ extraEnv: { LMNR_BASE_URL: "http://host.docker.internal" }, network: "net", serviceEnv: { LMNR_BASE_URL: "http://evil.example", DATABASE_URL: "postgres://x" } }), "/in", "/out");
    expect(both.lastIndexOf("LMNR_BASE_URL=http://host.docker.internal")).toBeGreaterThan(both.lastIndexOf("LMNR_BASE_URL=http://evil.example"));
  });

  it("keeps the SDK's sessions on the host when given a session mount, so a session survives the attempt", () => {
    const args = sandboxArgs(run({ sessionMount: "/state/tasks/t1/session" }), "/in", "/out");
    expect(args).toEqual(expect.arrayContaining(["-v", "/state/tasks/t1/session:/session", "-e", "CLAUDE_CONFIG_DIR=/session"]));
    expect(args).not.toContain("CLAUDE_CONFIG_DIR=/tmp/claude");
    expect(sandboxArgs(run(), "/in", "/out")).toContain("CLAUDE_CONFIG_DIR=/tmp/claude");
  });

  it("caps memory, cpu and process count, so a runaway stage cannot take the machine down", () => {
    const args = sandboxArgs(run(), "/i", "/o").join(" ");
    expect(args).toContain("--memory 4g");
    expect(args).toContain("--cpus 2");
    expect(args).toContain("--pids-limit 1024");
  });

  it("runs the stage as the machine's own user, so the bind mounts it owns are writable; null keeps the image's user", () => {
    const args = sandboxArgs(run(), "/i", "/o");
    const at = args.indexOf("--user");
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]).toMatch(/^\d+:\d+$/);
    expect(sandboxArgs(run({ user: null }), "/i", "/o")).not.toContain("--user");
    expect(sandboxArgs(run({ user: "1234:1234" }), "/i", "/o")).toContain("1234:1234");
    const check = sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["pnpm", "test"] });
    expect(check[check.indexOf("--user") + 1]).toMatch(/^\d+:\d+$/);
  });

  it("mounts the worktree read-only unless writable", () => {
    expect(sandboxArgs(run(), "/i", "/o")).toContain("/wt:/work:ro");
    expect(sandboxArgs(run({ writable: true }), "/i", "/o")).toContain("/wt:/work");
  });

  it("mounts the git dir read-only and passes extraEnv", () => {
    const args = sandboxArgs(run({ gitDir: "/g/.git", extraEnv: { LUNA_STAGE_DRY_RUN: "1" } }), "/i", "/o");
    expect(args).toContain("/g/.git:/g/.git:ro");
    expect(args.join(" ")).toContain("-e LUNA_STAGE_DRY_RUN=1");
  });

  it("mounts the user's git dir read-only even when the run is writable: nothing a container does may reach the repository", () => {
    const args = sandboxArgs(run({ writable: true, gitDir: "/g/.git" }), "/i", "/o");
    expect(args).toContain("/g/.git:/g/.git:ro");
    expect(args).not.toContain("/g/.git:/g/.git");
    expect(args.filter((_, i) => args[i - 1] === "-v" && _.startsWith("/g/.git"))).toEqual(["/g/.git:/g/.git:ro"]);
  });

  it("sizes the container from the run's limits, two CPUs and four gigabytes by default, keeping the process limit", () => {
    const flags = (args: string[]) => args.join(" ");
    expect(flags(sandboxArgs(run(), "/i", "/o"))).toContain("--memory 4g --cpus 2 --pids-limit 1024");
    expect(flags(sandboxArgs(run({ limits: { cpu: 2, memoryGb: 3 } }), "/i", "/o"))).toContain("--memory 3g --cpus 2 --pids-limit 1024");
    expect(flags(sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["x"], limits: { cpu: 6, memoryGb: 12 } }))).toContain("--memory 12g --cpus 6 --pids-limit 1024");
  });

  it("commits as you, unsigned: the container has no gitconfig and no gpg key", () => {
    const args = sandboxArgs(run({ gitIdentity: { name: "Ada L", email: "ada@x.dev" } }), "/i", "/o").join(" ");
    for (const env of ["GIT_AUTHOR_NAME=Ada L", "GIT_AUTHOR_EMAIL=ada@x.dev", "GIT_COMMITTER_NAME=Ada L", "GIT_COMMITTER_EMAIL=ada@x.dev"]) {
      expect(args).toContain(`-e ${env}`);
    }
    expect(args).toContain("-e GIT_CONFIG_COUNT=2");
    expect(args).toContain("-e GIT_CONFIG_KEY_1=commit.gpgsign -e GIT_CONFIG_VALUE_1=false");
    expect(sandboxArgs(run(), "/i", "/o").join(" ")).not.toContain("GIT_AUTHOR_NAME");
  });

  it("mounts the repo's cache volume at /cache and points every package manager's cache at it", () => {
    const args = sandboxArgs(run({ cacheVolume: "hardness-cache-app" }), "/i", "/o");
    expect(args).toEqual(expect.arrayContaining(["-v", "hardness-cache-app:/cache"]));
    const joined = args.join(" ");
    for (const env of CACHE_ENV) expect(joined).toContain(`-e ${env}`);
    expect(sandboxArgs(run(), "/i", "/o").join(" ")).not.toContain("/cache");
  });

  it("names a repo's cache volume after the repo, safely", () => {
    expect(cacheVolumeFor("/r/luna-tui")).toBe("hardness-cache-luna-tui");
    expect(cacheVolumeFor("/r/My App.v2/")).toBe("hardness-cache-my-app-v2");
  });

  it("joins the run's service network and gets what the services export, so the code finds its database by hostname", () => {
    const args = sandboxArgs(run({ network: "hardness-net-r1", serviceEnv: { DATABASE_URL: "postgres://app@postgres:5432/app" } }), "/i", "/o");
    expect(args).toEqual(expect.arrayContaining(["--network", "hardness-net-r1", "-e", "DATABASE_URL=postgres://app@postgres:5432/app"]));
    expect(sandboxArgs(run(), "/i", "/o")).not.toContain("--network");
  });

  it("passes the credential by name, never its value", () => {
    const args = sandboxArgs(run(), "/i", "/o");
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args.join(" ")).not.toContain("sk-secret-value");
  });

  it("mounts the engine's credential files where its runtime reads them: the Codex login's per-run copy, writable", () => {
    const codex = { env: { CODEX_HOME: "/tmp/.codex" }, mounts: [{ host: "/state/runs/r1/codex", container: "/tmp/.codex", readOnly: false }] };
    const args = sandboxArgs(run({ credential: codex }), "/i", "/o");
    expect(args).toEqual(expect.arrayContaining(["-e", "CODEX_HOME", "-v", "/state/runs/r1/codex:/tmp/.codex"]));
    expect(args).not.toContain("ANTHROPIC_API_KEY");
    const readOnly = sandboxArgs(run({ credential: { env: {}, mounts: [{ host: "/h", container: "/c", readOnly: true }] } }), "/i", "/o");
    expect(readOnly).toEqual(expect.arrayContaining(["-v", "/h:/c:ro"]));
  });
});

describe("sandboxExecArgs", () => {
  // A project's own checks (verify Step A, the locked-test replay) run in the stage image,
  // not on the host: node_modules installed by a Linux container hold Linux binaries.
  const args = sandboxExecArgs({
    name: "chk1",
    image: "img:1",
    worktree: "/wt",
    argv: ["npm", "run", "test"],
    env: { HARDNESS_STAGE: "verifying" },
  });

  it("runs the command as the entrypoint in the worktree, writable, and removes the container after", () => {
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toEqual(expect.arrayContaining(["--name", "chk1", "-v", "/wt:/work", "-w", "/work", "--entrypoint", "npm"]));
    expect(args.slice(-3)).toEqual(["img:1", "run", "test"]);
  });

  it("is hardened like a stage: read-only root, exec tmpfs, no new privileges, the limits, HOME on the tmpfs", () => {
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges", "-e", "HOME=/tmp", "-e", "TMPDIR=/tmp", "--memory", "4g"]));
  });

  it("mounts the same cache volume for a check run, so verify's install is warm too", () => {
    const args = sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["pnpm", "test"], cacheVolume: "hardness-cache-app" });
    expect(args).toEqual(expect.arrayContaining(["-v", "hardness-cache-app:/cache", "-e", "npm_config_cache=/cache/npm"]));
  });

  it("passes only the env it was given, never the host's, and no credential", () => {
    const envs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envs).toEqual([
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      "COREPACK_DEFAULT_TO_LATEST=0",
      ...["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"].map((n) => `${n}=`),
      "GIT_CONFIG_COUNT=2",
      "GIT_CONFIG_KEY_0=safe.directory",
      "GIT_CONFIG_VALUE_0=*",
      "GIT_CONFIG_KEY_1=commit.gpgsign",
      "GIT_CONFIG_VALUE_1=false",
      "HARDNESS_STAGE=verifying",
    ]);
    expect(args.join(" ")).not.toMatch(/ANTHROPIC|CLAUDE/);
  });

  it("joins the run's service network for a check too, with the exported env", () => {
    const args = sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["pnpm", "test"], network: "hardness-net-c", serviceEnv: { DATABASE_URL: "x" } });
    expect(args).toEqual(expect.arrayContaining(["--network", "hardness-net-c", "-e", "DATABASE_URL=x"]));
  });

  it("commits as you inside a check too: a suite that makes commits needs an identity, and the container has no gitconfig", () => {
    const joined = sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["pnpm", "test"], gitIdentity: { name: "Ada L", email: "ada@x.dev" } }).join(" ");
    for (const env of ["GIT_AUTHOR_NAME=Ada L", "GIT_AUTHOR_EMAIL=ada@x.dev", "GIT_COMMITTER_NAME=Ada L", "GIT_COMMITTER_EMAIL=ada@x.dev"]) {
      expect(joined).toContain(`-e ${env}`);
    }
    expect(args.join(" ")).not.toContain("GIT_AUTHOR_NAME");
  });

  it("points cargo's registry and its build output at the cache volume, so a retry does not rebuild a Rust crate from scratch", () => {
    expect(CACHE_ENV).toEqual(expect.arrayContaining(["CARGO_HOME=/cache/cargo", "CARGO_TARGET_DIR=/cache/cargo-target"]));
  });
});

describe("extra mounts and an entrypoint override", () => {
  it("mounts the extra mounts after the credential's, read-only when asked", () => {
    const args = sandboxArgs(run({ mounts: [{ host: "/state/graphs/repo/current", container: "/graph", readOnly: true }] }), "/i", "/o");
    expect(args).toEqual(expect.arrayContaining(["-v", "/state/graphs/repo/current:/graph:ro"]));
  });

  it("joins no network when asked and no service network is given", () => {
    expect(sandboxArgs(run({ networkNone: true }), "/i", "/o")).toEqual(expect.arrayContaining(["--network", "none"]));
    const withServices = sandboxArgs(run({ networkNone: true, network: "svc-net" }), "/i", "/o");
    expect(withServices).toEqual(expect.arrayContaining(["--network", "svc-net"]));
    expect(withServices).not.toContain("none");
    expect(sandboxArgs(run(), "/i", "/o")).not.toContain("--network");
  });

  it("overrides the entrypoint and passes the rest as the command after the image", () => {
    const args = sandboxArgs(run({ entrypoint: ["python3", "/graph-tools/build.py", "--input", "/work", "--out", "/graph"] }), "/i", "/o");
    const at = args.indexOf("--entrypoint");
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]).toBe("python3");
    expect(args.slice(args.indexOf("img:1") + 1)).toEqual(["/graph-tools/build.py", "--input", "/work", "--out", "/graph"]);
  });
});

describe("sandboxExecArgs with a linked worktree's .git file", () => {
  it("mounts the file read-only over /work/.git, after the /work mount", () => {
    const args = sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["pnpm", "test"], gitFile: "/wt/.git" });
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toContain("/wt/.git:/work/.git:ro");
    expect(mounts.indexOf("/wt:/work")).toBeLessThan(mounts.indexOf("/wt/.git:/work/.git:ro"));
  });

  it("mounts nothing extra without one", () => {
    const args = sandboxExecArgs({ name: "c", image: "i", worktree: "/wt", argv: ["pnpm", "test"] });
    expect(args.filter((a) => a.includes("/work/.git"))).toEqual([]);
  });
});

describe("sandboxExecutor's image", () => {
  const seen: string[] = [];
  const fake = (async (r: { image: string }) => (seen.push(r.image), { code: 0, stdout: "", stderr: "" })) as never;
  it("is the one the repository resolves to, given explicitly, never guessed from the folder", async () => {
    seen.length = 0;
    const exec = sandboxExecutor({ machine: "machine:dev", imageOf: async (repo) => `img-of-${repo}` }, fake);
    await exec("true", [], { cwd: "/wt/same-name/task-1", repoPath: "/a/shop" });
    await exec("true", [], { cwd: "/wt/same-name/task-2", repoPath: "/b/shop" });
    await exec("true", [], { cwd: "/wt/same-name/task-3" });
    expect(seen).toEqual(["img-of-/a/shop", "img-of-/b/shop", "machine:dev"]);
  });
});

describe("sandboxExecutor's list and size", () => {
  it("gives each check its repository's list and its own size, and the machine's defaults when no repository is named", async () => {
    const runs: Array<{ egress?: unknown; limits?: unknown }> = [];
    const fake = (async (r: { egress?: unknown; limits?: unknown }) => (runs.push(r), { code: 0, stdout: "", stderr: "" })) as never;
    const asked: Array<string | undefined> = [];
    const spec = { allow: ["github.com:443"], allowPrivate: [], proxyImage: "machine:dev" };
    const exec = sandboxExecutor({ machine: "machine:dev", imageOf: async () => "img", egress: async (repo) => (asked.push(repo), spec), limitsOf: async (repo) => (repo ? { cpu: 6, memoryGb: 12 } : { cpu: 2, memoryGb: 4 }) }, fake);
    await exec("true", [], { cwd: "/wt/a/task-1", repoPath: "/a/shop" });
    await exec("true", [], { cwd: "/wt/a/task-2" });
    expect(asked).toEqual(["/a/shop", undefined]);
    expect(runs[0]).toMatchObject({ egress: spec, limits: { cpu: 6, memoryGb: 12 } });
    expect(runs[1]).toMatchObject({ limits: { cpu: 2, memoryGb: 4 } });
  });
});

describe("the environment a repository's image cannot choose", () => {
  const NAMES = ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  it("is set empty on every stage container and every check container", () => {
    const stage = sandboxArgs(run(), "/in", "/out");
    const check = sandboxExecArgs({ name: "c", image: "img", worktree: "/wt", argv: ["true"] } as never);
    for (const args of [stage, check]) for (const name of NAMES) {
      const at = args.findIndex((a, i) => args[i - 1] === "-e" && a === `${name}=`);
      expect(at, name).toBeGreaterThan(-1);
    }
  });
});

describe("a run on a card network", () => {
  const cardNetwork = {
    name: "hardness-card-r1",
    dns: "172.30.0.2",
    containerArgs: (aliases: string[] = []) => ["--network", "hardness-card-r1", "--dns", "172.30.0.2", "-e", "HTTPS_PROXY=http://172.30.0.2:3128", "-e", `NO_PROXY=localhost,${aliases.join(",")}`],
    blocked: async () => [],
    teardown: async () => {},
  };

  it("joins it in place of the plain network, with its aliases, and never adds the host alias", () => {
    const args = sandboxArgs(run({ cardNetwork, alsoJoin: ["hardness-card-app"], extraEnv: { LMNR_BASE_URL: "http://host.docker.internal" } }), "/in", "/out");
    expect(args).toEqual(expect.arrayContaining(["--network", "hardness-card-r1", "--dns", "172.30.0.2", "-e", "HTTPS_PROXY=http://172.30.0.2:3128"]));
    expect(args.filter((a, i) => args[i - 1] === "--network")).toEqual(["hardness-card-r1", "hardness-card-app"]);
    expect(args).not.toContain("--add-host");
  });

  it("puts the proxy variables after a service's exports, so an export cannot take them", () => {
    const args = sandboxArgs(run({ cardNetwork, network: "x", serviceEnv: { HTTPS_PROXY: "http://evil" } }), "/in", "/out");
    expect(args.lastIndexOf("HTTPS_PROXY=http://172.30.0.2:3128")).toBeGreaterThan(args.lastIndexOf("HTTPS_PROXY=http://evil"));
  });

  it("does the same for a check", () => {
    const args = sandboxExecArgs({ name: "c1", image: "img", worktree: "/wt", argv: ["sh", "-c", "x"], cardNetwork, alsoJoin: ["other"] });
    expect(args).toEqual(expect.arrayContaining(["--network", "hardness-card-r1", "--dns", "172.30.0.2"]));
    expect(args.filter((a, i) => args[i - 1] === "--network")).toEqual(["hardness-card-r1", "other"]);
    expect(args).not.toContain("--add-host");
  });

  it("keeps a run with no card network exactly as before", () => {
    const args = sandboxArgs(run(), "/in", "/out");
    expect(args).not.toContain("--dns");
    expect(args).not.toContain("--network");
  });
});

describe("runSandbox and execInSandbox on a run's own network", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "docker-test-"));
    dirs.push(d);
    return d;
  };
  const rows = [{ host: "evil.example.com", port: 443, via: "connect" as const, reason: "not_listed", count: 1 }];
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

  /** Fake deps: every step lands in `events`, in order. */
  function fakes(over: { failRun?: boolean; open?: () => Promise<never> } = {}) {
    const events: string[] = [];
    const calls: string[][] = [];
    const network = (label: string) => ({
      name: `net-${label}`,
      dns: "172.30.0.2",
      containerArgs: () => ["--network", `net-${label}`, "--dns", "172.30.0.2"],
      blocked: async () => (events.push(`blocked ${label}`), rows),
      teardown: async () => void events.push(`teardown ${label}`),
    });
    const deps: RunDeps = {
      exec: async (_command, args) => {
        calls.push(args);
        if (args[0] === "wait") return ok("0\n");
        if (args[0] === "run") events.push("docker run --rm");
        return ok();
      },
      execOrThrow: async (_command, args) => {
        calls.push(args);
        events.push("docker run -d");
        if (over.failRun) throw new Error("docker run failed");
        return "";
      },
      startServices: async (_name, _services, options) => {
        events.push(`services on ${options?.network?.name ?? "none"}`);
        return { network: options?.network?.name ?? null, env: {}, teardown: async () => void events.push("teardown services") };
      },
      openCardNetwork: over.open ?? (async (name: string) => (events.push(`open ${name}`), network("own") as never)),
      findCardNetwork: async (name: string) => (events.push(`find ${name}`), network("found") as never),
    };
    return { deps, events, calls, network };
  }

  it("opens the network, starts the services on it, runs, reads what was blocked, then removes services and network, in that order", async () => {
    const { deps, events, calls } = fakes();
    const result = await runSandbox(run({ runDir: tmp(), egress: { allow: ["github.com:443"], allowPrivate: [], proxyImage: "machine:dev" }, services: { db: { image: "pg" } } }), deps);
    expect(events).toEqual(["open c1", "services on net-own", "docker run -d", "blocked own", "teardown services", "teardown own"]);
    expect(result.blocked).toEqual(rows);
    const started = calls.find((c) => c[0] === "run")!;
    expect(started).toEqual(expect.arrayContaining(["--network", "net-own", "--dns", "172.30.0.2"]));
  });

  it("removes the network when the container does not start, and when it is killed by the time limit", async () => {
    const failing = fakes({ failRun: true });
    await expect(runSandbox(run({ runDir: tmp(), egress: { allow: ["a.example.com:443"], allowPrivate: [], proxyImage: "m" } }), failing.deps)).rejects.toThrow("docker run failed");
    expect(failing.events.at(-1)).toBe("teardown own");
    const slow = fakes();
    slow.deps.exec = async (_c, args) => (args[0] === "wait" ? (await new Promise((r) => setTimeout(r, 40)), { code: 1, stdout: "", stderr: "" }) : ok());
    const result = await runSandbox(run({ runDir: tmp(), timeoutMs: 5, egress: { allow: ["a.example.com:443"], allowPrivate: [], proxyImage: "m" } }), slow.deps);
    expect(result.timedOut).toBe(true);
    expect(slow.events.at(-1)).toBe("teardown own");
  });

  it("refuses with the daemon's reason and starts nothing when the network cannot be made", async () => {
    const { deps, events } = fakes({ open: async () => { throw new EgressUnsupportedError("old daemon"); } });
    await expect(runSandbox(run({ runDir: tmp(), egress: { allow: ["a.example.com:443"], allowPrivate: [], proxyImage: "m" } }), deps)).rejects.toBeInstanceOf(EgressUnsupportedError);
    expect(events).toEqual([]);
  });

  it("joins the card network it is given and tears nothing of it down", async () => {
    const { deps, events, network } = fakes();
    const given = network("given") as never;
    await runSandbox(run({ runDir: tmp(), cardNetwork: given, services: { db: { image: "pg" } } }), deps);
    expect(events).toEqual(["services on net-given", "docker run -d", "teardown services"]);
  });

  it("behaves as before for a run with neither: no network opened", async () => {
    const { deps, events } = fakes();
    const result = await runSandbox(run({ runDir: tmp() }), deps);
    expect(events).toEqual(["services on none", "docker run -d", "teardown services"]);
    expect(result.blocked).toBeUndefined();
  });

  it("finds a re-attached run's network and proxy by name, runs nothing new and removes them when it ends", async () => {
    const { deps, events, calls } = fakes();
    const result = await runSandbox(run({ attach: true, runDir: tmp(), egress: { allow: ["a.example.com:443"], allowPrivate: [], proxyImage: "m" } }), deps);
    expect(events).toEqual(["find c1", "blocked found", "teardown found"]);
    expect(calls.some((c) => c[0] === "run")).toBe(false);
    expect(result.blocked).toEqual(rows);
  });

  it("does the same for a check: its result carries what was blocked, and the network goes after the container", async () => {
    const { deps, events, calls } = fakes();
    const result = await execInSandbox({ name: "chk1", image: "img", worktree: "/wt", argv: ["sh", "-c", "true"], egress: { allow: ["a.example.com:443"], allowPrivate: [], proxyImage: "m" } }, {}, deps);
    expect(events).toEqual(["open chk1", "services on net-own", "docker run --rm", "blocked own", "teardown services", "teardown own"]);
    expect(result.blocked).toEqual(rows);
    expect(calls.find((c) => c[0] === "run")).toEqual(expect.arrayContaining(["--network", "net-own"]));
  });
});

describe("corepack in every container", () => {
  it("keeps its downloads in the repository's cache volume and never prompts or takes the latest, for a stage and a check", () => {
    expect(CACHE_ENV).toContain("COREPACK_HOME=/cache/corepack");
    const stage = sandboxArgs(run({ cacheVolume: "vol" }), "/in", "/out");
    const check = sandboxExecArgs({ name: "c", image: "img", worktree: "/wt", argv: ["true"], cacheVolume: "vol" } as never);
    for (const args of [stage, check]) for (const env of ["COREPACK_HOME=/cache/corepack", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "COREPACK_DEFAULT_TO_LATEST=0"]) expect(args).toContain(env);
    // with no cache volume the two flags are still set
    const bare = sandboxArgs(run(), "/in", "/out");
    expect(bare).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT=0");
    expect(bare).not.toContain("COREPACK_HOME=/cache/corepack");
  });
});
