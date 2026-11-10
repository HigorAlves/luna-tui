import { describe, expect, it } from "vitest";

import { runFacts } from "./fold.ts";

const call = (tool: string, allowed = true) => ({ kind: "tool_call", payload: { tool, target: "x", allowed } });

describe("runFacts", () => {
  it("counts the calls that were allowed and the tools they used", () => {
    const facts = runFacts([call("Bash"), call("Read"), call("Bash"), call("Bash", false), { kind: "text", payload: { text: "hi" } }]);
    expect(facts.calls).toBe(3);
    expect(facts.tools).toEqual({ Bash: 2, Read: 1 });
  });

  it("lists the guard's events in order", () => {
    const facts = runFacts([
      { kind: "economy.guard", payload: { action: "gate", calls: 9 } },
      { kind: "economy.guard", payload: { action: "stop", calls: 20, cause: "repeat", failure: "abc1234567" } },
    ]);
    expect(facts.guard).toEqual([
      { action: "gate", calls: 9 },
      { action: "stop", calls: 20, cause: "repeat", failure: "abc1234567" },
    ]);
  });

  it("tolerates garbled lines", () => {
    const facts = runFacts([null, 3, "x", {}, { kind: 4 }, { kind: "tool_call" }, { kind: "tool_call", payload: { tool: 7, allowed: true } }, { kind: "economy.guard", payload: { action: "nope" } }, { kind: "economy.guard", payload: { action: "gate", calls: "x" } }, call("Read")]);
    expect(facts).toEqual({ calls: 1, guard: [], tools: { Read: 1 } });
  });
});
