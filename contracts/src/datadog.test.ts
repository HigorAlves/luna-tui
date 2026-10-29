import { describe, expect, it } from "vitest";

import { DatadogTriageAnswer, PACKS, TaskSource } from "./index.ts";

describe("datadog contracts", () => {
  it("the pack is haiku, low effort, three turns, no tools", () => {
    const pack = PACKS.datadog_triage;
    expect({ model: pack.model, effort: pack.effort, maxTurns: pack.maxTurns, tools: pack.tools, writable: pack.writable, agent: pack.agent }).toEqual({
      model: "haiku",
      effort: "low",
      maxTurns: 3,
      tools: [],
      writable: false,
      agent: "datadog-triager",
    });
  });

  it("caps the summary at 90 characters", () => {
    const item = { id: "inc:1", priority: "P0", category: "outage", summary: "x".repeat(91), why: "w", suspectedCause: null, nextStep: "n", refs: [] };
    expect(DatadogTriageAnswer.safeParse({ items: [item] }).success).toBe(false);
    expect(DatadogTriageAnswer.safeParse({ items: [{ ...item, summary: "x".repeat(90) }] }).success).toBe(true);
  });

  it("rejects a priority outside P0-P3", () => {
    const item = { id: "inc:1", priority: "P4", category: "outage", summary: "s", why: "w", suspectedCause: null, nextStep: "n", refs: [] };
    expect(DatadogTriageAnswer.safeParse({ items: [item] }).success).toBe(false);
  });

  it("a task can come from Datadog", () => {
    expect(TaskSource.safeParse({ kind: "datadog", source: "incident", id: "inc:42", url: "https://app.datadoghq.com/incidents/42" }).success).toBe(true);
  });
});
