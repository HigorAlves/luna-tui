import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { baselinePlan, parseEfforts } from "./baseline-plan.ts";

describe("baselinePlan", () => {
  const decisions = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);
  const lines = baselinePlan({ engines: ["claude:haiku", "codex:luna", "jev"] });

  it("starts with the preflight and ends with the scorecard and the defaults commands", () => {
    expect(lines[0]).toBe("pnpm eval preflight");
    expect(lines.at(-1)).toMatch(/^pnpm eval defaults/);
    expect(lines.some((l) => l === "pnpm eval scorecard")).toBe(true);
  });

  it("names every decision pack once per engine, in the order of PACKS", () => {
    for (const pack of decisions) for (const engine of ["claude:haiku", "codex:luna", "jev"]) expect(lines.filter((l) => l === `pnpm eval --pack ${pack} --engine ${engine} --save-baseline`)).toHaveLength(1);
    const runs = lines.filter((l) => l.startsWith("pnpm eval --pack"));
    expect(runs).toHaveLength(decisions.length * 3);
    expect(runs[0]).toContain(`--pack ${decisions[0]} --engine claude:haiku`);
    expect(runs[1]).toContain(`--pack ${decisions[0]} --engine codex:luna`);
  });

  it("adds an agent pack's run for each engine and effort the engine supports, and only with --efforts", () => {
    expect(baselinePlan({ engines: ["claude:haiku", "jev"], agentPacks: ["plan"] }).filter((l) => l.includes("--effort"))).toEqual([]);
    const agent = baselinePlan({ engines: ["claude:haiku", "jev"], efforts: ["low", "high"], agentPacks: ["plan"] }).filter((l) => l.startsWith("pnpm eval --pack plan "));
    expect(agent).toEqual([
      "pnpm eval --pack plan --engine claude:haiku --effort low --save-baseline",
      "pnpm eval --pack plan --engine claude:haiku --effort high --save-baseline",
    ]);
  });

  it("reads --efforts as a list of low, medium or high", () => {
    expect(parseEfforts("low, high")).toEqual(["low", "high"]);
    expect(() => parseEfforts("low,max")).toThrow("--efforts must be a list of low, medium or high");
  });

  it("runs nothing: it only returns text", () => {
    expect(lines.every((l) => typeof l === "string")).toBe(true);
  });
});
