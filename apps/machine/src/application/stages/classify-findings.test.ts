import { describe, expect, it } from "vitest";

import { classifyFindings } from "./classify-findings.ts";
import type { Decide } from "./check-decide.ts";

const finding = (i: number, severity: string) => ({ id: `F${i}`, path: "a", line: 1, severity, title: `t${i}`, body: "b", confidence: 0.9 }) as never;

describe("classifyFindings", () => {
  it("asks finding_classify for the most severe first, at most twenty, and counts agreement", async () => {
    const asked: string[] = [];
    const decide: Decide = async (_pack, check) => {
      asked.push((check as { finding: { id: string } }).finding.id);
      return { severity: { choice: "should_fix", confidence: 0.9 }, recordId: `r-${(check as { finding: { id: string } }).finding.id}` };
    };
    const findings = Array.from({ length: 25 }, (_, i) => finding(i, i === 24 ? "blocker" : "should_fix"));
    const out = await classifyFindings({ decide, repoPath: null, decisions: {}, excerpt: async () => "" }, findings);
    expect(asked).toHaveLength(20);
    expect(asked[0]).toBe("F24");
    expect(out.calibration).toEqual({ agree: 19, disagree: 1, skipped: 0 });
    expect(out.classified[0]).toMatchObject({ id: "F24", classified: "should_fix", verdict: "proceed" });
  });

  it("classifies nothing without a decision or without findings", async () => {
    expect(await classifyFindings({ decide: null, repoPath: null, decisions: {}, excerpt: async () => "" }, [finding(1, "nit")])).toEqual({ classified: [], calibration: { agree: 0, disagree: 0, skipped: 0 } });
  });
});
