import { describe, expect, it } from "vitest";

import { GraphBuildError, type GraphStamp } from "./graph.ts";
import { ensureGraphReady, graphSkipped, type GraphReadyDeps } from "./graph-ready.ts";

const stamp = (over: Partial<GraphStamp> = {}): GraphStamp => ({ schema: 1, commit: "a".repeat(40), builtAt: "t", nodes: 1, edges: 1, communities: 1, graphify: "0.9.34", ...over });

function make(over: { stamp?: GraphStamp | null; behind?: number | null; fresh?: boolean; builds?: (n: number) => Promise<GraphStamp>; policy?: object } = {}) {
  const notes: string[] = [];
  let have: GraphStamp | null = over.stamp === undefined ? null : over.stamp;
  let n = 0;
  const deps: GraphReadyDeps = {
    graph: {
      stampOf: async () => have,
      behind: async () => over.behind ?? 0,
      isFresh: async () => over.fresh ?? true,
      build: async () => {
        const s = await (over.builds ?? (async () => stamp()))(++n);
        have = s;
        return s;
      },
    },
    policies: { for: async () => ({ graph: true, factory: { graph: { stale_commits: 50, first_build_minutes: 10 } }, ...over.policy }) },
  };
  return { deps, notes, builds: () => n, call: (extra: { skip?: boolean; minutes?: number } = {}) => ensureGraphReady(deps, { repoPath: "/r", signal: new AbortController().signal, skip: extra.skip ?? false, note: async (t) => void notes.push(t), ...(extra.minutes ? { firstBuildMinutes: extra.minutes } : {}) }) };
}

describe("a card waits for its repository's graph", () => {
  it("builds a missing graph, says it is waiting, and is ready when it is built", async () => {
    const t = make();
    expect(await t.call()).toEqual({ state: "ready" });
    expect(t.builds()).toBe(1);
    expect(t.notes.join("\n")).toMatch(/waiting for the code graph/i);
  });

  it("does nothing for a graph that is current, and for a repository with graphs off", async () => {
    const t = make({ stamp: stamp() });
    expect(await t.call()).toEqual({ state: "ready" });
    expect(t.builds()).toBe(0);
    const off = make({ policy: { graph: false } });
    expect(await off.call()).toEqual({ state: "off" });
    expect(off.builds()).toBe(0);
  });

  it("rebuilds a graph further behind than graph.stale_commits, and uses one that is behind by less", async () => {
    const far = make({ stamp: stamp(), behind: 51 });
    await far.call();
    expect(far.builds()).toBe(1);
    const near = make({ stamp: stamp(), behind: 50 });
    await near.call();
    expect(near.builds()).toBe(0);
  });

  it("rebuilds a graph built by another Graphify", async () => {
    const t = make({ stamp: stamp(), fresh: false });
    await t.call();
    expect(t.builds()).toBe(1);
  });

  it("retries a failed build once and is ready when the second works", async () => {
    const t = make({ builds: async (n) => { if (n === 1) throw new GraphBuildError("exit code 1"); return stamp(); } });
    expect(await t.call()).toEqual({ state: "ready" });
    expect(t.builds()).toBe(2);
  });

  it("fails with the reason, flattened, after the second failure", async () => {
    const t = make({ builds: async () => { throw new GraphBuildError("build <b>failed</b>\n@alice"); } });
    const r = await t.call();
    expect(r).toMatchObject({ state: "failed", reason: expect.stringContaining("failed") });
    expect((r as { reason: string }).reason).not.toMatch(/[<>\n]/);
    expect(t.builds()).toBe(2);
  });

  it("gives up when the build outlasts graph.first_build_minutes", async () => {
    const t = make({ builds: () => new Promise<GraphStamp>(() => {}) });
    const r = await t.call({ minutes: 0.0005 });
    expect(r).toMatchObject({ state: "failed", reason: expect.stringMatching(/minutes/) });
  });

  it("lets the card go on without a graph when a person said so, and says so", async () => {
    const t = make({ builds: async () => { throw new GraphBuildError("x"); } });
    expect(await t.call({ skip: true })).toEqual({ state: "skipped" });
    expect(t.builds()).toBe(0);
  });

  it("reads the person's word from an approval's response", () => {
    expect(graphSkipped([{ response: { graph: "skip" } }, { response: null }] as never)).toBe(true);
    expect(graphSkipped([{ response: { graph: "wait" } }] as never)).toBe(false);
    expect(graphSkipped([])).toBe(false);
  });
});
