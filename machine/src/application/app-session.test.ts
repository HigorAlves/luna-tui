import { describe, expect, it } from "vitest";

import type { ExecResult } from "../adapters/process/exec.ts";
import { parseLunaConfig } from "../domain/luna-config.ts";
import { type AppDeps, e2eModeOf, openApp } from "./app-session.ts";

const yaml = (extra = "") => `verify:\n  e2e:\n    start:\n      command: npm start\n      port: 4000\n      ready: /up\n      ready_timeout_s: 5\n      secrets: [APP_KEY]\n    seed:\n      command: npm run seed\n      secrets: [SEED_KEY]\nservices:\n  db:\n    image: pg\n${extra}`;
const secretA = ["app", "k", "a".repeat(10)].join("-");
const secretB = ["seed", "k", "b".repeat(10)].join("-");
const input = { taskId: "abcd1234-0000", repoPath: "/user/repo", workspace: "/ws/card", commit: "c".repeat(40), attempt: 2 };

function setup(over: { seedExit?: number; probes?: number[]; running?: string; logs?: string; installOk?: boolean; missing?: string[]; text?: string } = {}) {
  const events: string[] = [];
  const dockerCalls: string[][] = [];
  const dockerEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const seedRuns: Array<{ secrets?: Record<string, string>; argv: string[] }> = [];
  const blocked: Array<[string, unknown]> = [];
  const probes = [...(over.probes ?? [0])];
  const rowsNow: Array<{ host: string; port: number; via: "connect" | "http" | "dns"; reason: string; count: number }> = [];
  const card = { name: "hardness-card-abcd1234-app-2", dns: "172.30.0.2", containerArgs: (a: string[] = []) => ["--network", "hardness-card-abcd1234-app-2", "--dns", "172.30.0.2", "-e", `NO_PROXY=localhost,${a.join(",")}`], blocked: async () => [...rowsNow], teardown: async () => void events.push("teardown network") };
  let t = 0;
  const deps: AppDeps = {
    policies: { for: async () => parseLunaConfig(over.text ?? yaml()) },
    imageFor: async () => "repo-image:1",
    install: async () => (events.push("install"), over.installOk === false ? { ok: false, detail: { escalation: "env_broken", step: "install" }, blocked: [] } : { ok: true, ran: [], notes: [], blocked: [] }),
    egress: { for: async (r) => (events.push(`egress ${r.kind}`), { allow: ["github.com:443"], allowPrivate: [], proxyImage: "machine:dev" }) },
    secrets: { folder: () => "/secrets/repo", load: async (_r, names) => ({ values: Object.fromEntries(names.filter((n) => !(over.missing ?? []).includes(n)).map((n) => [n, n === "APP_KEY" ? secretA : secretB])), missing: (over.missing ?? []).filter((m) => names.includes(m)).map((name) => ({ name, reason: "there is no such file" })) }) },
    openCardNetwork: async (run) => (events.push(`network ${run}`), card as never),
    startServices: async (run, _s, options) => (events.push(`services on ${options?.network?.name}`), { network: options?.network?.name ?? null, env: { DATABASE_URL: "postgres://db/app" }, teardown: async () => void events.push("teardown services") }),
    exec: async (run) => (events.push("seed"), seedRuns.push({ ...(run.secrets ? { secrets: run.secrets } : {}), argv: run.argv }), rowsNow.push({ host: "seed.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }), { code: over.seedExit ?? 0, stdout: `seeding ${secretB}\n`, stderr: "" }),
    docker: async (args, options) => {
      dockerCalls.push(args);
      dockerEnvs.push(options?.env);
      if (args[0] === "run") return (events.push("app"), rowsNow.push({ host: "app.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }), { code: 0, stdout: "id", stderr: "" } as ExecResult);
      if (args[0] === "exec") return { code: probes.length > 1 ? probes.shift()! : probes[0]!, stdout: "", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: over.running ?? "true", stderr: "" };
      if (args[0] === "logs") return { code: 0, stdout: over.logs ?? `listening with ${secretA}\n<script>alert(1)</script>`, stderr: "" };
      if (args[0] === "rm") events.push("rm app");
      return { code: 0, stdout: "", stderr: "" };
    },
    sleep: async () => void (t += 1000),
    now: () => t,
  };
  return { deps, events, dockerCalls, dockerEnvs, seedRuns, blocked, onBlocked: (step: string, rows: unknown) => void blocked.push([step, rows]) };
}

describe("e2eModeOf", () => {
  it("is deploy when a url_pattern is set, else start when a start command is, else target when the repository has QA targets, else agent", () => {
    const p = (text: string) => e2eModeOf(parseLunaConfig(text));
    expect(p("verify:\n  e2e:\n    deploy:\n      url_pattern: https://{branch}.example.com\n    start:\n      command: x\n")).toBe("deploy");
    expect(p("verify:\n  e2e:\n    start:\n      command: x\nqa_targets:\n  - name: s\n    url: https://s.example.com\n")).toBe("start");
    expect(p("qa_targets:\n  - name: s\n    url: https://s.example.com\n")).toBe("target");
    expect(p("")).toBe("agent");
  });
});

describe("openApp", () => {
  it("installs, opens a check-list network, starts the services on it, seeds, starts the app, and waits for it, in that order", async () => {
    const s = setup();
    const out = await openApp(s.deps, { ...input, onBlocked: s.onBlocked });
    expect(out.ok).toBe(true);
    expect(s.events).toEqual(["install", "egress check", "network abcd1234-app-2", "services on hardness-card-abcd1234-app-2", "seed", "app"]);
    if (out.ok) {
      expect(out.target).toEqual({ name: "app", baseUrl: "http://luna-app:4000" });
      expect(out.network).toBe("hardness-card-abcd1234-app-2");
      expect(out.aliases).toEqual(["luna-app", "db"]);
    }
    expect(s.seedRuns[0]!.argv).toEqual(["sh", "-c", "npm run seed"]);
    expect(s.seedRuns[0]!.secrets).toEqual({ SEED_KEY: secretB });
  });

  it("gives the app only its own secrets, by name on the command line and by value in the docker client's environment", async () => {
    const s = setup();
    await openApp(s.deps, { ...input, onBlocked: s.onBlocked });
    const run = s.dockerCalls.findIndex((c) => c[0] === "run");
    expect(s.dockerCalls[run]!).toEqual(expect.arrayContaining(["-e", "APP_KEY", "--network-alias", "luna-app"]));
    expect(s.dockerCalls[run]!.join(" ")).not.toContain("SEED_KEY");
    for (const a of s.dockerCalls.flat()) for (const v of [secretA, secretB]) expect(a).not.toContain(v);
    expect(s.dockerEnvs[run]!.APP_KEY).toBe(secretA);
  });

  it("probes from inside the container every second until the configured path answers, and gives up after ready_timeout_s", async () => {
    const ok = setup({ probes: [1, 1, 0] });
    expect((await openApp(ok.deps, { ...input, onBlocked: ok.onBlocked })).ok).toBe(true);
    const probes = ok.dockerCalls.filter((c) => c[0] === "exec");
    expect(probes).toHaveLength(3);
    expect(probes[0]!.slice(-2)).toEqual(["4000", "/up"]);
    const never = setup({ probes: [1] });
    const out = await openApp(never.deps, { ...input, onBlocked: never.onBlocked });
    expect(out).toMatchObject({ ok: false, detail: { escalation: "env_broken", envBroken: true, step: "start" } });
    expect(never.events.slice(-3)).toEqual(["rm app", "teardown services", "teardown network"]);
  });

  it("ends as env_broken at step seed, with the output flattened and redacted, when the seed fails, and starts no app", async () => {
    const s = setup({ seedExit: 3 });
    const out = await openApp(s.deps, { ...input, onBlocked: s.onBlocked });
    expect(out).toMatchObject({ ok: false, detail: { step: "seed", envBroken: true } });
    expect(JSON.stringify(out)).not.toContain(secretB);
    expect(JSON.stringify(out)).toContain("[secret:SEED_KEY]");
    expect(s.events).not.toContain("app");
    expect(s.events.at(-1)).toBe("teardown network");
  });

  it("flattens, caps and redacts the app's output in the reason, and stops at once when the app exits", async () => {
    const s = setup({ probes: [1], running: "false", logs: `boom ${secretA}\n<script>x</script>${"y".repeat(5000)}` });
    const out = await openApp(s.deps, { ...input, onBlocked: s.onBlocked });
    expect(out.ok).toBe(false);
    const text = JSON.stringify(out);
    expect(text).not.toContain(secretA);
    expect(text).not.toContain("<script>");
    expect(text.length).toBeLessThan(4000);
    expect(s.dockerCalls.filter((c) => c[0] === "exec")).toHaveLength(1);
  });

  it("returns the install's own escalation, and the missing secret's, without starting anything else", async () => {
    const a = setup({ installOk: false });
    expect(await openApp(a.deps, { ...input, onBlocked: a.onBlocked })).toMatchObject({ ok: false, detail: { step: "install" } });
    expect(a.events).toEqual(["install"]);
    const b = setup({ missing: ["SEED_KEY"] });
    const out = await openApp(b.deps, { ...input, onBlocked: b.onBlocked });
    expect(out).toMatchObject({ ok: false, detail: { step: "secrets", names: ["SEED_KEY"] } });
    expect(b.events).not.toContain("app");
  });

  it("reports what the proxy refused under step seed and then step app, each row once, and closes everything, twice safely", async () => {
    const s = setup();
    const out = await openApp(s.deps, { ...input, onBlocked: s.onBlocked });
    if (!out.ok) throw new Error("expected an app");
    await out.close();
    await out.close();
    expect(s.blocked.map(([step, rows]) => [step, (rows as Array<{ host: string }>).map((r) => r.host)])).toEqual([["seed", ["seed.example.com"]], ["app", ["app.example.com"]]]);
    expect(s.events.slice(-3)).toEqual(["rm app", "teardown services", "teardown network"]);
    expect(s.events.filter((e) => e === "rm app")).toHaveLength(1);
  });

  it("names a fresh app for each attempt", async () => {
    const s = setup();
    await openApp(s.deps, { ...input, attempt: 1, onBlocked: s.onBlocked });
    await openApp(s.deps, { ...input, attempt: 3, onBlocked: s.onBlocked });
    const names = s.dockerCalls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]);
    expect(names).toEqual(["hardness-abcd1234-app-1", "hardness-abcd1234-app-3"]);
  });
});

