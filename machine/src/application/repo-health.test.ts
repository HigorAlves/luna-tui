import { describe, expect, it } from "vitest";

import type { GraphStamp } from "./graph.ts";
import { repoHealthOf } from "./repo-health.ts";

const stamp: GraphStamp = { schema: 1, commit: "a".repeat(40), builtAt: "2026-11-05T10:00:00Z", nodes: 1, edges: 1, communities: 1, graphify: "0.9.34" };

describe("a repository's image and graph health", () => {
  it("says which image is in use, the base, when it was built, the last failure, and the graph's commit, distance, version, time, state and last failure", async () => {
    const [shop, plain, off] = await repoHealthOf({
      repos: ["/a/shop", "/a/plain", "/a/off"],
      policy: async (r) => ({ graph: r !== "/a/off", factory: { sandbox: { image: { base: r === "/a/shop" ? "python:3.13-slim" : null } } } }),
      machineImage: "hardness-runner:dev",
      images: { pending: async (r) => (r === "/a/plain" ? "attacker/x:1" : null), status: (r) => (r === "/a/shop" ? { image: "hardness-runner-shop:1", builtAt: "2026-11-05T09:00:00Z", lastFailure: "step 3 failed" } : null) },
      graph: { stampOf: async (r) => (r === "/a/off" ? null : stamp), behind: async () => 7 },
      watch: { health: (r) => ({ building: r === "/a/plain", lastFailure: r === "/a/shop" ? "exit code 1" : null }) },
    });
    expect(shop).toEqual({
      repo: "/a/shop",
      image: { inUse: "hardness-runner-shop:1", base: "python:3.13-slim", builtAt: "2026-11-05T09:00:00Z", lastFailure: "step 3 failed", pendingBase: null },
      graph: { on: true, commit: stamp.commit, behind: 7, graphify: "0.9.34", builtAt: stamp.builtAt, building: false, lastFailure: "exit code 1" },
    });
    expect(plain).toMatchObject({ image: { inUse: "hardness-runner:dev", base: null, builtAt: null, lastFailure: null, pendingBase: "attacker/x:1" }, graph: { building: true } });
    expect(shop!.image.pendingBase).toBeNull();
    expect(off).toMatchObject({ graph: { on: false, commit: null, behind: null, graphify: null, builtAt: null } });
  });

  it("shows a build a card's readiness wait started, which the watch never saw", async () => {
    const [row] = await repoHealthOf({
      repos: ["/a/shop"],
      policy: async () => ({ graph: true }),
      machineImage: "hardness-runner:dev",
      images: { pending: async () => null, status: () => null },
      graph: { stampOf: async () => null, health: () => ({ building: true, lastFailure: "the graph build failed (exit code 1)" }) },
      watch: { health: () => ({ building: false, lastFailure: null }) },
    });
    expect(row!.graph).toMatchObject({ building: true, lastFailure: "the graph build failed (exit code 1)" });
  });

  it("shows the devcontainer's image as the base, what it did not apply, and why the policy refused it", async () => {
    const [dev, plain] = await repoHealthOf({
      repos: ["/a/dev", "/a/plain"],
      policy: async () => ({ graph: true, factory: { sandbox: { image: { base: null } } } }),
      source: { for: async (r) => (r === "/a/dev" ? { base: "node:22", origin: "devcontainer" as const, containerEnv: {}, notes: ["devcontainer.json features: not applied: they need the devcontainers CLI"], bounds: ["devcontainer.json image refused"] } : { base: null, origin: null, containerEnv: {}, notes: [], bounds: [] }) },
      machineImage: "hardness-runner:dev",
      images: { pending: async () => null, status: () => null },
      graph: { stampOf: async () => null },
      watch: { health: () => ({ building: false, lastFailure: null }) },
    });
    expect(dev!.image.base).toBe("node:22");
    expect(dev!.notes).toEqual(["devcontainer.json features: not applied: they need the devcontainers CLI"]);
    expect(dev!.bounds).toEqual(["devcontainer.json image refused"]);
    expect(plain).not.toHaveProperty("notes");
  });

  it("shows what the machine's sandbox policy dropped from the repo's luna.yaml, only when it dropped something", async () => {
    const [bounded, plain] = await repoHealthOf({
      repos: ["/a/bounded", "/a/plain"],
      policy: async (r) => ({ graph: true, ...(r === "/a/bounded" ? { bounds: { notes: ["sandbox.cpu 16 is capped at 4"], egress: ['sandbox.egress.allow: "x.pastebin.com" dropped'], image: ['sandbox.image.base "node:22" is refused'], seccomp: null } } : { bounds: { notes: [], egress: [], image: [], seccomp: null } }) }),
      machineImage: "hardness-runner:dev",
      images: { pending: async () => null, status: () => null },
      graph: { stampOf: async () => null },
      watch: { health: () => ({ building: false, lastFailure: null }) },
    });
    expect(bounded!.bounds).toEqual(['sandbox.image.base "node:22" is refused', 'sandbox.egress.allow: "x.pastebin.com" dropped']);
    expect(plain).not.toHaveProperty("bounds");
  });
});
