import { describe, expect, it } from "vitest";

import type { Decide } from "./check-decide.ts";
import { decideEscalation } from "./escalation.ts";

const choice = (label: string, confidence: number) => ({ reason: { choice: label, confidence } });
const base = { stage: "implementing", summary: "Could not finish slice 2", output: "Error: Cannot find module './payments/v2'", repoPath: "/r", overrides: {}, facts: {} };

describe("decideEscalation", () => {
  it("lets a fact decide without asking a model: a second scope red is undeclared_scope, a service or container that never started is env_broken", async () => {
    const asked: unknown[] = [];
    const decide: Decide = async (...args) => (asked.push(args), choice("flaky_tests", 0.99));
    expect(await decideEscalation({ ...base, decide, facts: { scopeTwice: true } })).toMatchObject({ reason: "undeclared_scope", source: "fact", confidence: 1 });
    expect(await decideEscalation({ ...base, decide, facts: { envBroken: true } })).toMatchObject({ reason: "env_broken", source: "fact" });
    expect(asked).toEqual([]);
  });

  it("tells the decision the loop guard stopped the run, as one line of facts", async () => {
    const asked: Array<Record<string, any>> = [];
    const decide: Decide = async (_p, check) => (asked.push(check as never), choice("too_complex", 0.9));
    await decideEscalation({ ...base, decide, facts: { loopGuard: { cause: "the same test fails after each edit", failure: "abc1234567", calls: 31 } } });
    expect(asked[0]!.escalation.facts).toContain("the loop guard stopped the run: the same test fails after each edit after 31 calls");
  });

  it("decides a branch the container moved by fact: head_moved, no model asked", async () => {
    const asked: unknown[] = [];
    const decide: Decide = async (...args) => (asked.push(args), choice("flaky_tests", 0.99));
    expect(await decideEscalation({ ...base, decide, facts: { headMoved: true } })).toMatchObject({ reason: "head_moved", source: "fact", confidence: 1 });
    expect(asked).toEqual([]);
  });

  it("asks the decision otherwise, once, with the stage, the summary, the agent's word, the output's tail and the machine's facts, and takes a confident answer", async () => {
    const asked: Array<{ pack: string; check: Record<string, unknown> }> = [];
    const decide: Decide = async (pack, check) => (asked.push({ pack, check: check as never }), choice("plan_wrong", 0.9));
    const result = await decideEscalation({ ...base, decide, agent: { reason: "too_complex", text: "it is hard" }, facts: { budget: { spent: "iterations", numbers: "16 of 15 iterations", consecutiveReds: 3 } } });
    expect(result).toMatchObject({ reason: "plan_wrong", source: "decision", agentReason: "too_complex", confidence: 0.9 });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.pack).toBe("escalation_reason");
    expect(asked[0]!.check).toMatchObject({ kind: "escalation", escalation: { stage: "implementing", summary: "Could not finish slice 2", agentReason: "too_complex", agentWord: "it is hard", output: expect.stringContaining("payments/v2"), facts: expect.arrayContaining([expect.stringMatching(/16 of 15 iterations/), expect.stringMatching(/3 consecutive/)]) } });
  });

  it("gives a spent budget to the decision with its facts, not to too_complex by default", async () => {
    const decide: Decide = async () => choice("flaky_tests", 0.9);
    expect(await decideEscalation({ ...base, decide, facts: { budget: { spent: "minutes", numbers: "91 of 90 minutes", consecutiveReds: 0 } } })).toMatchObject({ reason: "flaky_tests", source: "decision" });
  });

  it("is `other`, for a person to read, under the bar, and keeps the agent's word beside it", async () => {
    const decide: Decide = async () => choice("plan_wrong", 0.4);
    expect(await decideEscalation({ ...base, decide, agent: { reason: "env_broken" } })).toMatchObject({ reason: "other", source: "decision", agentReason: "env_broken" });
  });

  it("leaves the agent's word when the decision cannot run or fails, and `other` when it said none", async () => {
    const boom: Decide = async () => { throw new Error("no jev"); };
    expect(await decideEscalation({ ...base, decide: boom, agent: { reason: "flaky_tests" } })).toMatchObject({ reason: "flaky_tests", source: "agent", confidence: null });
    expect(await decideEscalation({ ...base, decide: null, agent: {} })).toMatchObject({ reason: "other", source: "agent" });
    expect(await decideEscalation({ ...base, decide: null, agent: { reason: "head_moved" } })).toMatchObject({ reason: "other" });
  });

  it("flattens and caps what it sends and what it keeps: summary and words 500, output's tail 2000, at most 8 facts", async () => {
    const seen: Array<Record<string, any>> = [];
    const decide: Decide = async (_p, check) => (seen.push(check as never), choice("other", 0.9));
    const long = `x\n${"y".repeat(5000)}`;
    const result = await decideEscalation({ ...base, decide, summary: long, output: `${"z".repeat(5000)}THE TAIL`, agent: { text: long } });
    const sent = seen[0]!.escalation;
    expect(sent.summary.length).toBeLessThanOrEqual(500);
    expect(sent.summary).not.toContain("\n");
    expect(sent.agentWord.length).toBeLessThanOrEqual(500);
    expect(sent.output.length).toBeLessThanOrEqual(2000);
    expect(sent.output.endsWith("THE TAIL")).toBe(true);
    expect(result.outputTail.endsWith("THE TAIL")).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(500);
  });
});
