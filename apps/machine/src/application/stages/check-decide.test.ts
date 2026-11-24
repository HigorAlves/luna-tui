import { describe, expect, it, vi } from "vitest";

import { type Decide, judgeCheck } from "./check-decide.ts";

const check = { kind: "finding" as const };
const answer = { severity: { choice: "nit", confidence: 0.9 } };

describe("judgeCheck", () => {
  it("skips when there is no decide", async () => {
    expect(await judgeCheck(null, "finding_classify", check, "/repo", {})).toEqual({ verdict: "skipped", answer: null });
  });

  it("skips and logs when the decision throws", async () => {
    const log = vi.fn();
    const decide: Decide = async () => {
      throw new Error("no jev");
    };
    expect(await judgeCheck(decide, "finding_classify", check, "/repo", {}, log)).toEqual({ verdict: "skipped", answer: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("finding_classify skipped: no jev"));
  });

  it("is the pack's policy verdict over the answer", async () => {
    const decide: Decide = async () => answer;
    expect(await judgeCheck(decide, "finding_classify", check, "/repo", {})).toEqual({ verdict: "proceed", answer });
  });

  it("applies the repo's override for the pack", async () => {
    const decide: Decide = async () => answer;
    const result = await judgeCheck(decide, "finding_classify", check, "/repo", { finding_classify: { severity: { proceed: 0.95 } } });
    expect(result.verdict).toBe("flag");
  });

  it("hands the pack, the check and the repo path to the decision", async () => {
    const decide = vi.fn<Decide>(async () => answer);
    await judgeCheck(decide, "e2e_failure_cause", { kind: "e2e" }, "/repo", {});
    expect(decide).toHaveBeenCalledWith("e2e_failure_cause", { kind: "e2e" }, "/repo");
  });
});
