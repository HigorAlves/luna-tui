import { describe, expect, it } from "vitest";

import { failureGist } from "./failure-gist.ts";

const noisy = [
  "`pnpm --filter @hardness/machine test` failed:",
  "\u001b[22m\u001b[39mgithub prs: API rate limit exceeded (RATE_LIMITED)",
  "stderr | src/application/intake.test.ts > GitHubIntake.pollOnce > keeps polling",
  "github intake: o/bad: boom",
  ...Array.from({ length: 40 }, (_, n) => `log line ${n}`),
  " \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/adapters/git/clone.test.ts > a card's workspace > removes a failed move's repository",
  "AssertionError: promise resolved \"undefined\" instead of rejecting",
  " Test Files  1 failed | 310 passed (311)",
].join("\n");

describe("failureGist", () => {
  it("names the failing tests ahead of the noise a run printed first, and strips colour codes", () => {
    const gist = failureGist(noisy, 300);
    expect(gist).toContain("FAIL src/adapters/git/clone.test.ts");
    expect(gist).toContain("AssertionError");
    expect(gist).not.toContain("\u001b");
    expect(gist.length).toBeLessThanOrEqual(300);
  });

  it("falls back to the start of the text when no test is named", () => {
    expect(failureGist("lint failed: 3 problems", 300)).toBe("lint failed: 3 problems");
  });

  it("keeps at most three lines, each once", () => {
    const text = Array.from({ length: 6 }, (_, n) => `FAIL src/a${n % 2}.test.ts > case`).join("\n");
    expect(failureGist(text, 500).split(" | ")).toHaveLength(2);
  });
});
