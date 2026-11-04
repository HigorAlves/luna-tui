import { describe, expect, it } from "vitest";

import { type Graph, GraphBuildError, type GraphStamp } from "./graph.ts";
import { GraphWatch } from "./graph-watch.ts";

const stamp = (commit: string): GraphStamp => ({ schema: 1, commit, builtAt: "t", nodes: 1, edges: 1, communities: 1, graphify: "0.9.34" });

function setup(opts: { stamps?: Record<string, string>; heads?: Record<string, string>; off?: string[]; failing?: string[] } = {}) {
  const stamps = new Map(Object.entries(opts.stamps ?? {}));
  const heads = new Map(Object.entries(opts.heads ?? {}));
  const builds: string[] = [];
  let running = 0;
  let overlap = false;
  const logs: string[] = [];
  const graph: Graph = {
    stampOf: async (repo) => (stamps.has(repo) ? stamp(stamps.get(repo)!) : null),
    currentDir: () => null,
    build: async (repo) => {
      running++;
      overlap ||= running > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      builds.push(repo);
      if (opts.failing?.includes(repo)) throw new GraphBuildError("boom");
      stamps.set(repo, heads.get(repo) ?? "x");
      return stamp(heads.get(repo) ?? "x");
    },
    isFresh: async () => true,
  };
  const repos = Object.keys({ ...opts.stamps, ...opts.heads });
  const watch = new GraphWatch({
    graph,
    repos: async () => repos,
    policies: { for: async (repo) => ({ graph: !(opts.off ?? []).includes(repo) }) },
    defaultHead: async (repo) => heads.get(repo)!,
    log: (message) => logs.push(message),
  });
  return { watch, builds, logs, overlap: () => overlap };
}

describe("GraphWatch", () => {
  it("builds a repo whose default branch moved, or that has no graph, one at a time", async () => {
    const { watch, builds, overlap } = setup({ stamps: { "/a": "1", "/b": "2" }, heads: { "/a": "1", "/b": "3", "/c": "9" } });
    await watch.tick();
    expect(builds.sort()).toEqual(["/b", "/c"]);
    expect(overlap()).toBe(false);
    await watch.tick();
    expect(builds).toHaveLength(2);
  });

  it("skips a repo whose luna.yaml turns the graph off", async () => {
    const { watch, builds } = setup({ heads: { "/a": "1", "/b": "1" }, off: ["/a"] });
    await watch.tick();
    expect(builds).toEqual(["/b"]);
  });

  it("logs a failed build and goes on to the next repo", async () => {
    const { watch, builds, logs } = setup({ heads: { "/a": "1", "/b": "1" }, failing: ["/a"] });
    await watch.tick();
    expect(builds.sort()).toEqual(["/a", "/b"]);
    expect(logs.join("\n")).toMatch(/\/a.*boom/);
  });

  it("ensure() schedules a first build when there is no graph, without waiting for it", async () => {
    const { watch, builds } = setup({ heads: { "/a": "1" } });
    watch.ensure("/a");
    expect(builds).toEqual([]);
    await watch.idle();
    expect(builds).toEqual(["/a"]);
  });

  it("ensure() leaves a repo with a graph, or with the graph off, alone", async () => {
    const { watch, builds } = setup({ stamps: { "/a": "1" }, heads: { "/a": "2", "/b": "1" }, off: ["/b"] });
    watch.ensure("/a");
    watch.ensure("/b");
    await watch.idle();
    expect(builds).toEqual([]);
  });
});
