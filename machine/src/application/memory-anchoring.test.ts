import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { DEFAULT_STALE_LINES, isStaleByAnchors, sweepStale } from "./memory-anchoring.ts";

const draft = (text: string, anchors: { files: string[]; commit: string | null }, repo = "app-1") => ({
  kind: "outcome" as const,
  repo,
  source: { kind: "github" as const, ref: null },
  anchors,
  provenance: { by: "machine" as const, card: "c1", run: null, pack: null },
  trust: "fact" as const,
  text,
});

async function world(lines: Record<string, number | null>, staleLines?: number) {
  const memory = fakeMemory();
  await memory.write([
    draft("quiet", { files: ["a.ts"], commit: "aaaaaaa" }),
    draft("busy", { files: ["b.ts"], commit: "bbbbbbb" }),
    draft("exactly the limit", { files: ["c.ts"], commit: "ccccccc" }),
    draft("no file", { files: [], commit: null }),
    draft("no commit", { files: ["d.ts"], commit: null }),
    draft("other repo", { files: ["b.ts"], commit: "bbbbbbb" }, "web-2"),
  ]);
  const calls: string[] = [];
  const deps = {
    memory,
    repoPaths: async () => ["/r/app"],
    slugOf: (p: string) => (p === "/r/app" ? "app-1" : "web-2"),
    linesChanged: async (_repo: string, commit: string, files: readonly string[]) => (calls.push(`${commit}:${files.join(",")}`), lines[files[0]!] ?? null),
    ...(staleLines !== undefined ? { staleLines: async () => staleLines } : {}),
  };
  return { memory, deps, calls };
}

const status = (memory: Awaited<ReturnType<typeof world>>["memory"], text: string) => memory.items.find((i) => i.text === text)!.status;

describe("sweepStale", () => {
  it("marks stale the active items whose anchored files changed past 200 lines, and only those", async () => {
    const { memory, deps, calls } = await world({ "a.ts": 12, "b.ts": 201, "c.ts": 200 });
    expect(await sweepStale(deps)).toEqual({ checked: 3, staled: 1 });
    expect(status(memory, "busy")).toBe("stale");
    expect(status(memory, "quiet")).toBe("active");
    expect(status(memory, "exactly the limit")).toBe("active");
    expect(status(memory, "no file")).toBe("active");
    expect(status(memory, "no commit")).toBe("active");
    expect(status(memory, "other repo")).toBe("active");
    expect(calls).toEqual(["aaaaaaa:a.ts", "bbbbbbb:b.ts", "ccccccc:c.ts"]);
  });

  it("is idempotent: a stale item is not looked at again", async () => {
    const { deps } = await world({ "a.ts": 0, "b.ts": 900, "c.ts": 0 });
    expect(await sweepStale(deps)).toEqual({ checked: 3, staled: 1 });
    expect(await sweepStale(deps)).toEqual({ checked: 2, staled: 0 });
  });

  it("reads the repository's own limit and leaves an item whose lines are unknown alone", async () => {
    const { memory, deps } = await world({ "a.ts": 12, "b.ts": null, "c.ts": 200 }, 10);
    expect(await sweepStale(deps)).toEqual({ checked: 3, staled: 2 });
    expect(status(memory, "quiet")).toBe("stale");
    expect(status(memory, "exactly the limit")).toBe("stale");
    expect(status(memory, "busy")).toBe("active");
  });

  it("survives a git failure on one item and does nothing with memory off", async () => {
    const { memory, deps } = await world({});
    const failing = { ...deps, linesChanged: async () => Promise.reject(new Error("bad object")) };
    expect(await sweepStale(failing)).toEqual({ checked: 3, staled: 0 });
    expect(memory.items.every((i) => i.status === "active")).toBe(true);
    expect(await sweepStale({ ...deps, memory: { ...memory, enabled: false } })).toEqual({ checked: 0, staled: 0 });
  });
});

describe("isStaleByAnchors", () => {
  it("answers for one item, for a recall to ask", async () => {
    const memory = fakeMemory();
    const [anchored, bare] = await memory.write([draft("a", { files: ["a.ts"], commit: "aaaaaaa" }), draft("b", { files: [], commit: null })]);
    expect(await isStaleByAnchors(anchored!, "/r/app", async () => DEFAULT_STALE_LINES + 1)).toBe(true);
    expect(await isStaleByAnchors(anchored!, "/r/app", async () => DEFAULT_STALE_LINES)).toBe(false);
    expect(await isStaleByAnchors(anchored!, "/r/app", async () => null)).toBe(false);
    expect(await isStaleByAnchors(anchored!, "/r/app", async () => 50, 10)).toBe(true);
    expect(await isStaleByAnchors(bare!, "/r/app", async () => 9999)).toBe(false);
  });
});
