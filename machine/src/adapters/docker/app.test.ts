import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { APP_ALIAS, PROBE_SCRIPT, appArgs, probeArgs, removeLeftoverApps } from "./app.ts";

const secret = ["app", "key", "k".repeat(10)].join("-");
const card = { name: "hardness-card-x", dns: "172.30.0.2", containerArgs: (a: string[] = []) => ["--network", "hardness-card-x", "--dns", "172.30.0.2", "-e", `NO_PROXY=localhost,${a.join(",")}`], blocked: async () => [], teardown: async () => {} };
const spec = { name: "hardness-abcd1234-app-1", image: "repo-image:1", worktree: "/ws/card", command: "npm run start", port: 3000, serviceEnv: { DATABASE_URL: "postgres://db/app" }, secrets: { APP_KEY: secret }, limits: { cpu: 6, memoryGb: 12 }, cacheVolume: "hardness-cache-repo", cardNetwork: card as never, services: { db: { image: "pg" } } };

describe("appArgs", () => {
  const args = appArgs(spec);

  it("runs the app detached, under its own name, reachable as luna-app on its card network, with no published port", () => {
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(args[args.indexOf("--name") + 1]).toBe("hardness-abcd1234-app-1");
    expect(args).toEqual(expect.arrayContaining(["--network", "hardness-card-x", "--network-alias", APP_ALIAS, "--label", "dev.hardness.stage=1"]));
    for (const flag of ["-p", "--publish", "-P", "--publish-all", "--rm"]) expect(args).not.toContain(flag);
  });

  it("is the stage's hardening, the repository's size, the work folder and the cache volume, with PORT, HOST and the services' exports", () => {
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--security-opt", "no-new-privileges", "--memory", "12g", "--cpus", "6", "-v", "/ws/card:/work", "-w", "/work", "PORT=3000", "HOST=0.0.0.0", "DATABASE_URL=postgres://db/app"]));
    expect(args.join(" ")).toContain("hardness-cache-repo:/cache");
    expect(args.join(" ")).toContain("NO_PROXY=localhost,db");
  });

  it("starts the command through sh, holds no credential variable, names its secret without the value, and the network gives it no proxy of the agent", () => {
    const at = args.indexOf("--entrypoint");
    expect(args.slice(at, at + 5)).toEqual(["--entrypoint", "sh", "repo-image:1", "-c", "npm run start"]);
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"]) expect(args.join(" ")).not.toContain(name);
    expect(args).toEqual(expect.arrayContaining(["-e", "APP_KEY"]));
    for (const a of args) expect(a).not.toContain(secret);
  });
});

describe("the readiness probe", () => {
  it("is a fixed script run inside the app's container, with the port and the configured path as arguments, never inside the script", () => {
    const args = probeArgs("hardness-abcd1234-app-1", 3000, "/healthz?x=1;touch /tmp/p");
    expect(args).toEqual(["exec", "hardness-abcd1234-app-1", "/opt/luna/bin/node", "-e", PROBE_SCRIPT, "3000", "/healthz?x=1;touch /tmp/p"]);
    expect(PROBE_SCRIPT).not.toContain("healthz");
    expect(PROBE_SCRIPT).toContain("127.0.0.1");
  });
});

describe("removeLeftoverApps", () => {
  it("removes an app container a killed machine left running, found by its label and name", async () => {
    const calls: string[][] = [];
    const exec = async (_c: string, a: string[]): Promise<ExecResult> => (calls.push(a), a[0] === "ps" ? { code: 0, stdout: "id1\nid2\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    expect(await removeLeftoverApps(exec)).toBe(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["--filter", "label=dev.hardness.stage=1", "--filter", "name=-app-"]));
    expect(calls[1]).toEqual(["rm", "-f", "id1", "id2"]);
  });
});
