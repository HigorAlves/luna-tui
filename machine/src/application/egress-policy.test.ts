import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { egressPolicy } from "./egress-policy.ts";
import { PolicyStore } from "./policy.ts";

let root: string;
let checkout: string;
let work: string;
const policies = () => new PolicyStore({ warn: () => {} });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "egress-policy-"));
  checkout = join(root, "checkout");
  work = join(root, "card-workspace");
  mkdirSync(checkout);
  mkdirSync(work);
  writeFileSync(join(checkout, "luna.yaml"), "sandbox:\n  egress:\n    allow: [docs.example.com]\n");
  writeFileSync(join(checkout, "pnpm-lock.yaml"), "packages:\n  x:\n    resolution: {tarball: https://artifacts.example.org/x.tgz}\n");
  // The card's own folder holds a policy and a lockfile that try to widen its list.
  writeFileSync(join(work, "luna.yaml"), "sandbox:\n  egress:\n    allow: [evil.example]\n");
  writeFileSync(join(work, "package-lock.json"), '{"resolved": "https://evil.example/x.tgz"}');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("egressPolicy", () => {
  const base = { policies: policies(), proxyImage: "machine:dev" };

  it("builds a check's list from the user's checkout: GitHub, its allow list, the registries its lockfiles name", async () => {
    const spec = await egressPolicy({ ...base, policies: policies() }).for({ repoPath: checkout, kind: "check" });
    expect(spec.proxyImage).toBe("machine:dev");
    expect(spec.allow).toEqual(expect.arrayContaining(["github.com:443", "docs.example.com:443", "registry.npmjs.org:443", "artifacts.example.org:443"]));
    expect(spec.allowPrivate).toEqual([]);
  });

  it("never takes a host from the card's work folder: its luna.yaml and its lockfile do not move the list", async () => {
    const spec = await egressPolicy({ ...base, policies: policies() }).for({ repoPath: checkout, kind: "agent", owners: ["claude"] });
    expect(JSON.stringify(spec)).not.toContain("evil.example");
    // and a policy asked for the work folder itself is the policy of that folder only when it is named as the repository
    expect(await egressPolicy({ ...base, policies: policies() }).for({ repoPath: checkout, kind: "agent", owners: ["claude"] })).toEqual(spec);
  });

  it("gives an agent its engine's hosts and the machine's extra ones, and a check neither", async () => {
    const policy = egressPolicy({ ...base, policies: policies(), engineHosts: ["gateway.example.net"] });
    const agent = await policy.for({ repoPath: checkout, kind: "agent", owners: ["claude", "codex"], targets: ["staging.example.com"] });
    expect(agent.allow).toEqual(expect.arrayContaining(["api.anthropic.com:443", "chatgpt.com:443", "gateway.example.net:443", "staging.example.com:443"]));
    const check = await policy.for({ repoPath: checkout, kind: "check", owners: ["claude"], targets: ["staging.example.com"] });
    for (const host of ["api.anthropic.com:443", "chatgpt.com:443", "gateway.example.net:443", "staging.example.com:443"]) expect(check.allow).not.toContain(host);
  });

  it("gives an agent the two trace ports as private entries, and no one else", async () => {
    const policy = egressPolicy({ ...base, policies: policies(), traceEntries: ["host.docker.internal:8000", "host.docker.internal:8001"] });
    expect((await policy.for({ repoPath: checkout, kind: "agent", owners: ["claude"] })).allowPrivate).toEqual(["host.docker.internal:8000", "host.docker.internal:8001"]);
    expect((await policy.for({ repoPath: null, kind: "pack", owners: ["claude"] })).allowPrivate).toEqual(["host.docker.internal:8000", "host.docker.internal:8001"]);
    expect((await policy.for({ repoPath: checkout, kind: "check" })).allowPrivate).toEqual([]);
  });

  it("closes the registries to a check when the repository says `install`", async () => {
    const closed = mkdtempSync(join(root, "closed-"));
    writeFileSync(join(closed, "luna.yaml"), "sandbox:\n  egress:\n    registries: install\n");
    writeFileSync(join(closed, "pnpm-lock.yaml"), "x: 1\n");
    const policy = egressPolicy({ ...base, policies: policies() });
    expect((await policy.for({ repoPath: closed, kind: "check" })).allow).not.toContain("registry.npmjs.org:443");
    expect((await policy.for({ repoPath: closed, kind: "install" })).allow).toContain("registry.npmjs.org:443");
  });

  it("gives a pack with no repository its engine's hosts alone, and reads no lockfile", async () => {
    const spec = await egressPolicy({ ...base, policies: policies() }).for({ repoPath: null, kind: "pack", owners: ["openai"] });
    expect(spec.allow).toEqual(["api.openai.com:443"]);
  });

  it("reads a lockfile that is a link, or too big, as absent", async () => {
    const odd = mkdtempSync(join(root, "odd-"));
    writeFileSync(join(odd, "real.lock"), "x");
    symlinkSync(join(odd, "real.lock"), join(odd, "pnpm-lock.yaml"));
    writeFileSync(join(odd, "yarn.lock"), "0123456789");
    const reads: string[] = [];
    const spec = await egressPolicy({ ...base, policies: policies(), readLockfile: async (path) => (reads.push(path), (await import("../adapters/fs/bounded.ts")).readRegularFile(path, 4)) }).for({ repoPath: odd, kind: "check" });
    expect(spec.allow).not.toContain("registry.npmjs.org:443");
    expect(reads.some((r) => r.endsWith("pnpm-lock.yaml"))).toBe(true);
  });
});
