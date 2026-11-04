import { describe, expect, it } from "vitest";

import { type GraphJson, blastRadius } from "./blast-radius.ts";

// c.ts calls b.ts, b.ts imports a.ts; d.ts stands alone. An edge points from the dependent to what it uses.
const graph: GraphJson = {
  nodes: [
    { id: "A", source_file: "src/a.ts" },
    { id: "B", source_file: "src/b.ts" },
    { id: "C", source_file: "src/c.ts" },
    { id: "D", source_file: "src/d.ts" },
  ],
  links: [
    { source: "B", target: "A", source_file: "src/b.ts" },
    { source: "C", target: "B", source_file: "src/c.ts" },
  ],
};

describe("blastRadius", () => {
  it("is the files that depend on the changed ones, two hops out by default, never the changed files themselves", () => {
    expect(blastRadius(graph, ["src/a.ts"])).toEqual(["src/b.ts", "src/c.ts"]);
    expect(blastRadius(graph, ["src/a.ts", "src/b.ts"])).toEqual(["src/c.ts"]);
  });

  it("stops at the depth asked for and leaves unrelated files out", () => {
    expect(blastRadius(graph, ["src/a.ts"], 1)).toEqual(["src/b.ts"]);
    expect(blastRadius(graph, ["src/d.ts"])).toEqual([]);
    expect(blastRadius(graph, ["src/c.ts"])).toEqual([]);
  });

  it("reads a leading ./ or /work/ off both sides, and an edge whose ends are objects", () => {
    const objects: GraphJson = { nodes: [{ id: "A", source_file: "/work/src/a.ts" }, { id: "B", source_file: "./src/b.ts" }], links: [{ source: { id: "B" }, target: { id: "A" } }] };
    expect(blastRadius(objects, ["./src/a.ts"])).toEqual(["src/b.ts"]);
  });

  it("is sorted, without duplicates, and capped at 60", () => {
    const nodes = [{ id: "A", source_file: "a.ts" }, ...Array.from({ length: 80 }, (_, i) => ({ id: `N${i}`, source_file: `f${String(i).padStart(2, "0")}.ts` }))];
    const links = nodes.slice(1).flatMap((n) => [{ source: n.id, target: "A" }, { source: n.id, target: "A" }]);
    const radius = blastRadius({ nodes, links }, ["a.ts"]);
    expect(radius).toHaveLength(60);
    expect(radius).toEqual([...radius].sort());
    expect(radius[0]).toBe("f00.ts");
  });

  it("tolerates a graph with no nodes or links", () => {
    expect(blastRadius({}, ["a.ts"])).toEqual([]);
  });
});
