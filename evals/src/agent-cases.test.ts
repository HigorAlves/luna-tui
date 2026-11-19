import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { replayMcp } from "@hardness/machine/mcp-replay";
import { loadCases, mcpServersOf } from "./cases.ts";
import { casesTable } from "./preflight.ts";

const EVALS = resolve(import.meta.dirname, "..");

describe("the agent packs' first cases", () => {
  it("has three plan cases that load and carry a rubric", () => {
    const cases = loadCases(EVALS, "plan");
    expect(cases.map((c) => c.id)).toEqual(["cli-sum-names", "web-item-count", "web-vague-speed"].sort());
    for (const c of cases) {
      expect(c.expect.rubric.length).toBeGreaterThan(80);
      expect(c.input.context.plan?.risk).toBeDefined();
    }
  });

  it("has three decompose cases: a small one, a cross-module one and one that must split", () => {
    const cases = loadCases(EVALS, "decompose");
    expect(cases.map((c) => c.id)).toEqual(["cart-small-fixes", "cart-count-and-clear", "cart-csv-and-storage"].sort());
    for (const c of cases) {
      const split = c.input.context.split!;
      const ids = split.origin.criteria.map((k) => k.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(split.children).toEqual([]);
      expect(split.round).toBe(1);
    }
  });

  it("lists an agent pack's cases for a person to read", () => {
    const rows = casesTable(EVALS, "plan");
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).toContain("web-vague-speed");
    expect(rows.join("\n")).not.toContain("no reading");
  });
});

describe("the designer packs' cases (RFC 0013)", () => {
  it("has three design_spec cases, each on replayed design servers", () => {
    const cases = loadCases(EVALS, "design_spec");
    expect(cases.map((c) => c.id)).toEqual(["checkout-tokens", "injected-layer-name", "missing-states"]);
    for (const c of cases) {
      expect(c.mcpDir, c.id).toBeDefined();
      expect(existsSync(join(c.mcpDir!, "figma", "tools.json")), c.id).toBe(true);
      expect(c.input.context.design?.refs.length, c.id).toBeGreaterThan(0);
      expect(c.expect.rubric, c.id).toMatch(/invent/);
      expect(c.expect.checks.length, c.id).toBeGreaterThan(0);
    }
  });

  it("replays a recorded call of each spec case's frame", async () => {
    for (const c of loadCases(EVALS, "design_spec")) {
      const ref = c.input.context.design!.refs[0]!;
      const mcp = replayMcp(mcpServersOf(c.mcpDir!), c.mcpDir!);
      const answer = await mcp.callTool("figma", "get_design_context", { fileKey: ref.fileKey, nodeId: ref.nodeIds[0] });
      expect(answer.ok, c.id).toBe(true);
    }
  });

  it("has three a11y_audit cases on seeded pages, one clean", () => {
    const cases = loadCases(EVALS, "a11y_audit");
    expect(cases.map((c) => c.id)).toEqual(["clean-page", "seeded-axe", "seeded-judged"]);
    for (const c of cases) {
      expect(c.mcpDir, c.id).toBeUndefined();
      expect(c.input.task.repoPath, c.id).toMatch(/^fixtures\/a11y-/);
      expect(existsSync(join(EVALS, "..", c.input.task.repoPath, "index.html")), c.id).toBe(true);
      expect(c.input.context.qaTargets, c.id).toEqual([{ name: "seeded", baseUrl: "file:///work/index.html" }]);
      expect(c.input.context.a11y, c.id).toEqual({ level: "AA" });
      expect(c.expect.rubric, c.id).toMatch(/false blocker/);
    }
    const clean = cases.find((c) => c.id === "clean-page")!;
    expect(clean.expect.checks).toContainEqual({ kind: "count", path: "findings", max: 1 });
  });
});
