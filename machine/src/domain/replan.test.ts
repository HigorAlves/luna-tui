import { describe, expect, it } from "vitest";

import { REPLAN_OUTPUT_CAP, REPLAN_THREAD_CAP, replanOf } from "./replan.ts";

const token = ["ghp", "a".repeat(36)].join("_");

describe("replanOf: the evidence a wrong plan goes back to the planner with", () => {
  it("says who raised it, why, and the failing output's tail and the findings, as data", () => {
    const replan = replanOf({ raisedBy: "verifying", reason: "the plan names a module that does not exist", finished: { detail: { error: "boom" }, findings: [{ title: "x is missing", path: "a.ts", line: 3 }] } });
    expect(replan).toEqual({ raised_by: "verifying", reason: "the plan names a module that does not exist", output: "boom", findings: ["a.ts:3 x is missing"] });
  });

  it("keeps the tail of a long output through safe(), capped at 2,000: one line, no HTML, no mention, no token", () => {
    const out = `${"early noise ".repeat(500)}\n<script>alert(1)</script> @everyone fixes #12 ${token}\nlast line`;
    const { output } = replanOf({ raisedBy: "implementing", reason: "r", finished: { detail: { output: out } } });
    expect(output!.length).toBeLessThanOrEqual(REPLAN_OUTPUT_CAP);
    expect(output).toMatch(/last line$/);
    expect(output).not.toMatch(/\n|<script>|@everyone|#12|ghp_/);
  });

  it("keeps the reviewer's thread through postable(), capped at 1,500 characters", () => {
    const thread = `[click](https://evil.example/x) ![i](https://evil.example/i.png) @team ${"word ".repeat(500)}`;
    const { thread: kept } = replanOf({ raisedBy: "shipping", reason: "the review says the plan is wrong", finished: { detail: { thread } } });
    expect(kept!.length).toBeLessThanOrEqual(REPLAN_THREAD_CAP);
    expect(kept).not.toMatch(/\]\(|!\[|@team/);
    expect(kept).toContain("click (https://evil.example/x)");
  });

  it("flattens and caps the reason and each finding, takes at most ten findings, and leaves out what is missing", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ title: `f${i} ${"y".repeat(400)}` }));
    const replan = replanOf({ raisedBy: "verifying", reason: `a\nb ${"z".repeat(900)}`, finished: { findings: many } });
    expect(replan.reason).not.toContain("\n");
    expect(replan.reason.length).toBeLessThanOrEqual(500);
    expect(replan.findings).toHaveLength(10);
    expect(replan.findings![0]!.length).toBeLessThanOrEqual(200);
    const bare = replanOf({ raisedBy: "implementing", reason: "r", finished: null });
    expect(bare).toEqual({ raised_by: "implementing", reason: "r" });
  });
});
