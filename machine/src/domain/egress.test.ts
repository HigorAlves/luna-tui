import { describe, expect, it } from "vitest";

import { ENGINE_HOSTS, GITHUB_HOSTS, type EgressInputs, egressFor } from "./egress.ts";

const base: EgressInputs = { allow: [], registries: "always", registryHosts: ["registry.npmjs.org"] };
const owners = ["claude", "codex", "openai", "typesafe"] as const;

describe("the host tables", () => {
  it("lists GitHub's hosts exactly, with no wildcard", () => {
    expect([...GITHUB_HOSTS]).toEqual(["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
    expect(GITHUB_HOSTS.some((h) => h.includes("*"))).toBe(false);
  });

  it("names each engine owner's API hosts", () => {
    expect(ENGINE_HOSTS.claude).toEqual(["api.anthropic.com"]);
    expect(ENGINE_HOSTS.codex).toEqual(["chatgpt.com", "auth.openai.com", "api.openai.com"]);
    expect(ENGINE_HOSTS.openai).toEqual(["api.openai.com"]);
    expect(ENGINE_HOSTS.typesafe).toEqual(["ai-gateway.vercel.sh", "api.typesafe.ai"]);
  });
});

describe("egressFor", () => {
  it("gives an install GitHub, the repository's allow list and the registries, each with a port", () => {
    const { allow, allowPrivate } = egressFor("install", { ...base, allow: ["Docs.Example.com", "*.cdn.example.com:8443"], registries: "install" });
    expect(allow).toEqual([...allow].sort());
    expect(allow).toEqual(expect.arrayContaining(["github.com:443", "api.github.com:443", "docs.example.com:443", "*.cdn.example.com:8443", "registry.npmjs.org:443"]));
    expect(allow).toHaveLength(new Set(allow).size);
    expect(allowPrivate).toEqual([]);
  });

  it("gives a check the registries only when `registries` is always", () => {
    expect(egressFor("check", base).allow).toContain("registry.npmjs.org:443");
    expect(egressFor("check", { ...base, registries: "install" }).allow).not.toContain("registry.npmjs.org:443");
    expect(egressFor("check", { ...base, registries: "install" }).allow).toContain("github.com:443");
  });

  it("gives an agent what a check has, its engine's hosts, each helper's, the machine's extra hosts and the browser targets", () => {
    const { allow } = egressFor("agent", { ...base, owners: ["codex", "claude"], engineHosts: ["gateway.example.com"], targets: ["staging.example.com"] });
    expect(allow).toEqual(expect.arrayContaining(["github.com:443", "registry.npmjs.org:443", "chatgpt.com:443", "auth.openai.com:443", "api.openai.com:443", "api.anthropic.com:443", "gateway.example.com:443", "staging.example.com:443"]));
    expect(allow).not.toContain("ai-gateway.vercel.sh:443");
  });

  it("gives a pack with no repository the engine's hosts only", () => {
    const { allow } = egressFor("pack", { ...base, allow: ["x.example.com"], owners: ["claude"] });
    expect(allow).toEqual(["api.anthropic.com:443"]);
  });

  it("puts the machine's trace entries in allowPrivate for an agent and a pack, never for an install or a check", () => {
    const withTraces = { ...base, owners: ["claude" as const], machineEntries: ["host.docker.internal:4318"] };
    expect(egressFor("agent", withTraces).allowPrivate).toEqual(["host.docker.internal:4318"]);
    expect(egressFor("pack", withTraces).allowPrivate).toEqual(["host.docker.internal:4318"]);
    expect(egressFor("install", withTraces).allowPrivate).toEqual([]);
    expect(egressFor("check", withTraces).allowPrivate).toEqual([]);
    expect(egressFor("agent", withTraces).allow).not.toContain("host.docker.internal:4318");
  });

  it("drops an entry that is not a host pattern, wherever it came from, and a private entry with a wildcard", () => {
    const { allow, allowPrivate } = egressFor("agent", { ...base, owners: ["claude"], allow: ["1.2.3.4", "*", "ok.example.com"], engineHosts: ["localhost"], targets: ["http://x.example.com"], machineEntries: ["*.internal:4318", "host.docker.internal:4318"] });
    expect(allow).not.toContain("1.2.3.4:443");
    expect(allow).toContain("ok.example.com:443");
    expect(allow.some((a) => a.includes("localhost") || a.includes("http"))).toBe(false);
    expect(allowPrivate).toEqual(["host.docker.internal:4318"]);
  });

  it("never gives an install or a check an engine host, for every combination", () => {
    const engineHosts = Object.values(ENGINE_HOSTS).flat();
    for (const kind of ["install", "check"] as const)
      for (const registries of ["install", "always"] as const)
        for (const o of [[], ...owners.map((x) => [x]), [...owners]] as Array<Array<(typeof owners)[number]>>) {
          const { allow } = egressFor(kind, { ...base, registries, owners: o, engineHosts: ["gateway.example.com"], targets: ["staging.example.com"] });
          for (const host of engineHosts) expect(allow, `${kind} ${registries} ${o.join()}`).not.toContain(`${host}:443`);
          expect(allow).not.toContain("gateway.example.com:443");
          expect(allow).not.toContain("staging.example.com:443");
        }
  });
});
