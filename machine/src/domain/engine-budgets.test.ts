import { describe, expect, it } from "vitest";

import { capsOn, overCap, reached } from "./engine-budgets.ts";

const spend = new Map([
  ["openai:sol", 12],
  ["openai:luna", 9],
  ["codex:sol", 0],
  ["jev", 4.5],
]);

describe("capsOn", () => {
  it("is the engine's own cap, then its credential's, each with what has been spent against it", () => {
    expect(capsOn("openai:sol", { "openai:sol": 15, openai: 20 }, spend)).toEqual([
      { key: "openai:sol", limitUsd: 15, spentUsd: 12 },
      { key: "openai", limitUsd: 20, spentUsd: 21 },
    ]);
    expect(capsOn("jev", { typesafe: 5 }, spend)).toEqual([{ key: "typesafe", limitUsd: 5, spentUsd: 4.5 }]);
    expect(capsOn("codex:luna", { openai: 20 }, spend)).toEqual([]);
  });
});

describe("reached", () => {
  it("is spent at or past the cap; a zero cap only once something was spent, so it never trips on Codex's subscription", () => {
    expect(reached(20, 20)).toBe(true);
    expect(reached(19.99, 20)).toBe(false);
    expect(reached(0, 0)).toBe(false);
    expect(reached(0.01, 0)).toBe(true);
  });
});

describe("overCap", () => {
  it("names the first cap reached and the amounts, or null", () => {
    expect(overCap("openai:sol", { "openai:sol": 15, openai: 20 }, spend)).toBe("over its monthly budget ($21.00 of $20.00 on openai)");
    expect(overCap("openai:sol", { "openai:sol": 12 }, spend)).toBe("over its monthly budget ($12.00 of $12.00 on openai:sol)");
    expect(overCap("codex:sol", { codex: 0 }, spend)).toBeNull();
    expect(overCap("openai:sol", {}, spend)).toBeNull();
  });
});
