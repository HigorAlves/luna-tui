// The loop guard's rules: how a call folds into a segment's state, the free gate, the stuck test, the backstop and the redirect text.
import type { Observation } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { backstopHit, foldSpiral, gateOpen, isStuck, newSpiral, redirectText, stagnation, type Spiral } from "./rules.ts";

const call = { tool: "bash", target: "pnpm test" };
const SAME = "aaaaaaaaaa";

/** A segment of `n` calls: the first ones carry the given observations, the rest are quiet reads. */
function segment(n: number, observations: Observation[]): Spiral {
  const s = newSpiral();
  for (let i = 0; i < n; i++) foldSpiral(s, observations[i] ?? {}, i < observations.length ? call : { tool: "read", target: "src/a.ts" });
  return s;
}

/** 4 edits of one file, 5 failures of one kind (4 repeats) and 1 of another: 6 error outputs. */
const STUCK_SIGNS: Observation[] = [
  { edits: ["src/a.ts"] },
  { edits: ["src/a.ts"] },
  { edits: ["src/a.ts"] },
  { edits: ["src/a.ts"] },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: "bbbbbbbbbb", errorClass: "Error" },
];

describe("isStuck", () => {
  it("holds for 20 calls, 4 edits of one file, 6 error outputs and 4 repeats", () => {
    const s = segment(20, STUCK_SIGNS);
    expect(s.errorOutputs).toBe(6);
    expect(s.repeatedFailures).toBe(4);
    expect(isStuck(s)).toBe(true);
  });

  it("does not hold for the same signs in 19 calls", () => {
    expect(isStuck(segment(19, STUCK_SIGNS))).toBe(false);
  });

  it("holds when three files are edited once each instead of one file four times", () => {
    const edits = [{ edits: ["a.ts"] }, { edits: ["b.ts"] }, { edits: ["c.ts"] }, ...STUCK_SIGNS.slice(4)];
    expect(isStuck(segment(20, edits))).toBe(true);
  });

  it("does not hold with only 5 error outputs", () => {
    expect(isStuck(segment(20, STUCK_SIGNS.slice(0, 9)))).toBe(false);
  });

  it("does not hold when fewer than a fifth of the failures repeat", () => {
    const distinct = Array.from({ length: 6 }, (_, i) => ({ failure: `${String(i).repeat(10)}`, errorClass: "Error" }));
    const s = segment(20, [...STUCK_SIGNS.slice(0, 4), ...distinct]);
    expect(stagnation(s)).toBe(0);
    expect(isStuck(s)).toBe(false);
  });

  it("does not hold when no file is edited often enough or widely enough", () => {
    const edits = [{ edits: ["a.ts"] }, { edits: ["a.ts"] }, { edits: ["b.ts"] }, ...STUCK_SIGNS.slice(4)];
    expect(isStuck(segment(20, edits))).toBe(false);
  });
});

describe("gateOpen", () => {
  it("stays shut under 20 calls even with a repeated failure", () => {
    expect(gateOpen(segment(19, [{ failure: SAME }, { failure: SAME }]))).toBe(false);
  });

  it("opens at 20 calls with one repeated failure", () => {
    expect(gateOpen(segment(20, [{ failure: SAME }, { failure: SAME }]))).toBe(true);
  });

  it("opens at 20 calls with 8 error outputs and no repeat", () => {
    const errors = Array.from({ length: 8 }, () => ({ errorClass: "Error" }));
    expect(gateOpen(segment(20, errors))).toBe(true);
    expect(gateOpen(segment(20, errors.slice(0, 7)))).toBe(false);
  });
});

describe("backstopHit", () => {
  it("needs more than the multiple of the envelope, and a stuck segment", () => {
    const stuck20 = segment(20, STUCK_SIGNS);
    expect(backstopHit(stuck20, 8, 2.5)).toBe(false); // 20 is not more than 20
    expect(backstopHit(stuck20, 7, 2.5)).toBe(true);
    expect(backstopHit(segment(30, STUCK_SIGNS.slice(0, 9)), 4, 2.5)).toBe(false); // not stuck
  });
});

describe("foldSpiral", () => {
  it("counts a verification from testsRan or from a test or build intent", () => {
    const s = segment(3, [{ testsRan: true }, { intent: "test" }, { intent: "build" }]);
    expect(s.testRuns).toBe(3);
  });

  it("counts a call with an empty observation as a call", () => {
    expect(segment(5, []).turns).toBe(5);
  });

  it("keeps base names only in the action log and cuts a command to 90 characters", () => {
    const s = newSpiral();
    foldSpiral(s, {}, { tool: "bash", target: `cd /home/me/project && ${"x".repeat(200)}` });
    foldSpiral(s, {}, { tool: "read", target: "/home/me/project/src/secret.ts" });
    expect(s.recent[0]).not.toContain("/home");
    expect(s.recent[0]!.replace(/^\s*\d+: /, "").length).toBeLessThanOrEqual(92);
    expect(s.recent[1]).toBe("  2: read secret.ts");
  });

  it("keeps the last 40 actions", () => {
    expect(segment(55, []).recent).toHaveLength(40);
  });
});

describe("redirectText", () => {
  it("fills the template with the counts of the segment", () => {
    const s = segment(20, STUCK_SIGNS);
    expect(redirectText(s)).toBe(
      "Process check (automated): so far you've made 4 edits across 1 file(s) (most to `a.ts`) and run 0 verification(s), and the same failure has recurred 4 time(s) without the tests going green. This looks like a repetitive loop. Do NOT stop — instead step back and try a MATERIALLY DIFFERENT hypothesis: re-read the failing test's expectation, consider a different file or root cause than the ones you've been editing, and verify the new hypothesis directly before editing again.",
    );
  });

  it("names one file when nothing was edited", () => {
    expect(redirectText(newSpiral())).toContain("(most to `one file`)");
  });
});
