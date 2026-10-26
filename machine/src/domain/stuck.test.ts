import { describe, expect, it } from "vitest";

import { ALTERNATING_LIMIT, SAME_CALL_LIMIT, StuckDetector } from "./stuck.ts";

// The transcript a stage prints: one `→ <Tool> <target>` line per tool call, text between.
const feedAll = (lines: string[]) => {
  const d = new StuckDetector();
  let reason: string | null = null;
  for (const line of lines) reason ??= d.feed(line);
  return reason;
};

describe("StuckDetector", () => {
  it("flags the same call repeated four times in a row", () => {
    const reason = feedAll(["→ Read /work/src/cart.js", ...Array(SAME_CALL_LIMIT).fill("→ Bash npm test")]);
    expect(reason).toBe("the same call 4 times in a row: Bash npm test");
  });

  it("flags two calls alternating six times, the red-green loop that never turns green", () => {
    const pair = ["→ Edit /work/src/cart.js", "→ Bash npm test"];
    const reason = feedAll(Array(ALTERNATING_LIMIT / 2).fill(pair).flat());
    expect(reason).toBe("alternating between two calls 6 times: Edit /work/src/cart.js / Bash npm test");
  });

  it("stays quiet on ordinary work: three repeats, a varied sequence, and text lines", () => {
    expect(feedAll(["→ Bash npm test", "→ Bash npm test", "→ Bash npm test"])).toBeNull();
    expect(feedAll(["→ Read a", "→ Edit a", "→ Bash npm test", "→ Edit b", "→ Bash npm test", "→ git commit"])).toBeNull();
    expect(feedAll(["Red confirmed.", "Thinking about the fix.", "→ Edit a", "still thinking", "→ Bash npm test"])).toBeNull();
  });

  it("ignores text between calls when counting repeats", () => {
    const lines = ["→ Bash npm test", "fails again", "→ Bash npm test", "hm", "→ Bash npm test", "→ Bash npm test"];
    expect(feedAll(lines)).toMatch(/same call 4 times/);
  });
});
