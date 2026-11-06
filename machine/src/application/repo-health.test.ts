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
      images: { status: (r) => (r === "/a/shop" ? { image: "hardness-runner-shop:1", builtAt: "2026-11-05T09:00:00Z", lastFailure: "step 3 failed" } : null) },
      graph: { stampOf: async (r) => (r === "/a/off" ? null : stamp), behind: async () => 7 },
      watch: { health: (r) => ({ building: r === "/a/plain", lastFailure: r === "/a/shop" ? "exit code 1" : null }) },
    });
    expect(shop).toEqual({
      repo: "/a/shop",
      image: { inUse: "hardness-runner-shop:1", base: "python:3.13-slim", builtAt: "2026-11-05T09:00:00Z", lastFailure: "step 3 failed" },
      graph: { on: true, commit: stamp.commit, behind: 7, graphify: "0.9.34", builtAt: stamp.builtAt, building: false, lastFailure: "exit code 1" },
    });
    expect(plain).toMatchObject({ image: { inUse: "hardness-runner:dev", base: null, builtAt: null, lastFailure: null }, graph: { building: true } });
    expect(off).toMatchObject({ graph: { on: false, commit: null, behind: null, graphify: null, builtAt: null } });
  });
});
