import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { replayMcp } from "@hardness/machine/mcp-replay";
import { loadCases, mcpServersOf, mountsOf } from "./cases.ts";
import { Expect, runCheck } from "./expect.ts";
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

describe("design_parity cases (RFC 0013)", () => {
  const cases = loadCases(EVALS, "design_parity");
  const PLANTED = ["layout-wrap", "radius", "spacing-drift", "token-swap", "type-size"];

  it("has the planted differences, the missing capture and the clean pairs", () => {
    expect(cases.map((c) => c.id)).toEqual(["clean-desktop", "clean-mobile", "layout-wrap", "missing-hover", "radius", "spacing-drift", "token-swap", "type-size"]);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s: its captures are mounted, its frames replay, and its checks are well formed", async (id, c) => {
    expect(c.input.pack).toBe("design_parity");
    expect(c.expect.checks.length, id).toBeGreaterThan(0);
    expect(c.expect.rubric, id).toMatch(/invent/);
    const mounts = mountsOf(c.mountsDir);
    expect(mounts).toEqual([expect.objectContaining({ container: "/evidence", readOnly: true })]);
    for (const cap of c.input.context.parity!.captures) {
      expect(existsSync(join(c.mountsDir!, cap.image.replace(/^\//, ""))), cap.image).toBe(true);
      expect(existsSync(join(c.mountsDir!, cap.styles!.replace(/^\//, ""))), cap.styles!).toBe(true);
    }
    expect(existsSync(join(c.mcpDir!, "figma", "tools.json"))).toBe(true);
    // Every cited frame's render replays as a real PNG of the frame's size: the bridge writes it to /design/<n>-<i>.png.
    const mcp = replayMcp(mcpServersOf(c.mcpDir!), c.mcpDir!);
    const ref = c.input.context.design?.refs[0] ?? { fileKey: "Qx7LmP2vR9sTa" };
    for (const t of c.input.context.parity!.plan.targets) {
      const node = c.input.context.parity!.spec!.frames.find((f) => f.id === t.frame)!.states.find((s) => s.state === t.state)?.nodeId ?? t.frame;
      const shot = await mcp.callTool("figma", "get_screenshot", { fileKey: ref.fileKey, nodeId: node });
      expect(shot.ok, `${id} ${node}`).toBe(true);
      if (!shot.ok) continue;
      const png = shot.images[0]!.bytes;
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(t.viewport.width);
      expect(png.readUInt32BE(20)).toBe(t.viewport.height);
    }
  });

  it("expects a finding at the planted frame in each planted case, and no blocker or should_fix in a clean one", () => {
    const text = (id: string) => JSON.stringify(cases.find((c) => c.id === id)!.expect.checks);
    for (const id of PLANTED) expect(text(id), id).toContain('"findings[frame=12:34]"');
    for (const id of ["clean-desktop", "clean-mobile"]) {
      expect(text(id)).toContain("findings[level=blocker]");
      expect(text(id)).toContain("findings[level=should_fix]");
    }
    expect(text("missing-hover")).toContain("frames[state=hover].status");
  });

  it("grades a good answer for each case as a pass and an answer that finds nothing as a miss", () => {
    for (const c of cases) {
      const good = JSON.parse(readFileSync(join(c.mountsDir!, "..", "good-answer.json"), "utf8"));
      for (const check of Expect.parse(c.expect).checks) expect(runCheck(good, check).pass, `${c.id}: ${runCheck(good, check).check}`).toBe(true);
      if (PLANTED.includes(c.id) || c.id === "missing-hover") {
        const blind = { frames: good.frames.map((f: object) => ({ ...f, status: "compared" })), findings: [], designInput: "complete", confidence: 0.9, summary: "" };
        expect(c.expect.checks.some((check) => !runCheck(blind, check).pass), c.id).toBe(true);
      }
    }
  });
});
