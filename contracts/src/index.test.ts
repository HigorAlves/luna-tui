import { describe, expect, it } from "vitest";

import { DecisionInput, EditPlanInput } from "./api.ts";
import { COLUMNS, COLUMN_OF, RUNNING, TaskState, WAITING_ON_USER } from "./index.ts";

describe("task states", () => {
  it("puts every state in a board column", () => {
    for (const state of TaskState.options) {
      expect(COLUMNS).toContain(COLUMN_OF[state]);
    }
  });

  it("keeps every board column reachable", () => {
    const used = new Set(Object.values(COLUMN_OF));
    expect([...used].sort()).toEqual([...COLUMNS].sort());
  });

  it("only waits on the user in gate states", () => {
    for (const state of WAITING_ON_USER) {
      expect(TaskState.options).toContain(state);
    }
    expect(WAITING_ON_USER.has("implementing")).toBe(false);
  });

  it("never treats a state as both running and waiting on the user", () => {
    for (const state of RUNNING) {
      expect(WAITING_ON_USER.has(state)).toBe(false);
    }
  });

  it("rejects unknown states", () => {
    expect(TaskState.safeParse("done").success).toBe(false);
  });
});

describe("edit plan input", () => {
  it("accepts a partial edit", () => {
    expect(EditPlanInput.parse({ criteria: ["c1", "c2"] })).toEqual({ criteria: ["c1", "c2"] });
  });
  it("accepts every field", () => {
    expect(EditPlanInput.parse({ brief: "b", criteria: ["c"], assumptions: ["a"] })).toEqual({
      brief: "b",
      criteria: ["c"],
      assumptions: ["a"],
    });
  });
  it("rejects an empty edit", () => {
    expect(EditPlanInput.safeParse({}).success).toBe(false);
  });
});

describe("decision input", () => {
  it("accepts applyRules and keeps it", () => {
    expect(DecisionInput.parse({ decision: "approved", applyRules: false, reason: "rules skipped" })).toEqual({
      decision: "approved",
      applyRules: false,
      reason: "rules skipped",
    });
  });
  it("leaves applyRules optional", () => {
    expect(DecisionInput.parse({ decision: "approved" })).toEqual({ decision: "approved" });
  });
});
