import { describe, expect, it } from "vitest";

import { DecisionInput, EditCasesInput, EditPlanInput } from "./api.ts";
import { readFileSync } from "node:fs";
import { COLUMNS, COLUMN_OF, RUNNING, TERMINAL, TaskState, WAITING_ON_USER, isTerminal } from "./index.ts";

describe("task states", () => {
  it("ends in closed or archived, both in Done", () => {
    expect([...TERMINAL]).toEqual(["closed", "archived"]);
    expect(COLUMN_OF.archived).toBe("Done");
    expect(isTerminal("archived")).toBe(true);
    expect(isTerminal("implementing")).toBe(false);
  });

  it("puts every state in a board column", () => {
    for (const state of TaskState.options) {
      expect(COLUMNS).toContain(COLUMN_OF[state]);
    }
  });

  it("draws the columns as the diagram's seven stages, then Done", () => {
    expect([...COLUMNS]).toEqual(["Intake", "Triage", "Plan", "Build", "Verify", "Evidence", "Ship", "Done"]);
    const states = (column: string) => TaskState.options.filter((s) => COLUMN_OF[s] === column);
    expect(states("Intake")).toEqual(["draft", "setup", "awaiting_setup"]);
    expect(states("Triage")).toEqual(["triage", "awaiting_answers"]);
    expect(states("Plan")).toEqual(["awaiting_approval", "test_design", "awaiting_test_check"].sort((a, b) => TaskState.options.indexOf(a as never) - TaskState.options.indexOf(b as never)));
    expect(states("Build")).toEqual(expect.arrayContaining(["implementing", "paused_rate_limit", "escalated"]));
    expect(states("Verify")).toEqual(expect.arrayContaining(["verifying", "e2e", "delivering", "ci_watch"]));
    expect(states("Evidence")).toEqual(["evidence"]);
    expect(states("Ship")).toEqual(expect.arrayContaining(["awaiting_ship", "shipping", "reviewing_memory"]));
    expect(states("Done")).toEqual(["closed", "archived"]);
  });

  it("keeps the PR tasks where they were: reviewing under Verify, addressing under Build", () => {
    expect(COLUMN_OF.reviewing).toBe("Verify");
    expect(COLUMN_OF.addressing).toBe("Build");
  });

  it("is the one table the board reads: the Rust board names the same columns in the same order", () => {
    const board = readFileSync(new URL("../../board/src/model.rs", import.meta.url), "utf8");
    const named = /pub const COLUMNS: \[&str; (\d+)\] =\s*\[([^\]]*)\]/.exec(board);
    expect(named).not.toBeNull();
    expect(Number(named![1])).toBe(COLUMNS.length);
    expect([...named![2]!.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...COLUMNS]);
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
  it("accepts steps, a rollback, a risk level with its reason and a code map with its reason", () => {
    const edit = {
      steps: [{ description: "Cap a coupon", files: ["src/cart.ts"], done_when: ["a second use is rejected"], est_loc: 30 }],
      rollback: "revert the commit",
      risk: { level: "high", reason: "touches billing" },
      map: { components: ["cart"], files: [{ path: "src/cart.ts", role: "change" }], entry_points: [], owners: ["@marta"], reason: "ownership moved" },
    };
    expect(EditPlanInput.parse(edit)).toEqual(edit);
  });
  it("bounds what a person types: a level from the enum, a reason that is there and short, steps and files capped, roles from the enum", () => {
    const risk = (r: unknown) => EditPlanInput.safeParse({ risk: r }).success;
    expect(risk({ level: "huge", reason: "r" })).toBe(false);
    expect(risk({ level: "high" })).toBe(false);
    expect(risk({ level: "high", reason: "" })).toBe(false);
    expect(risk({ level: "high", reason: "x".repeat(501) })).toBe(false);
    expect(EditPlanInput.safeParse({ rollback: "x".repeat(4001) }).success).toBe(false);
    const step = { description: "d", files: ["a"], done_when: ["x"], est_loc: 1 };
    expect(EditPlanInput.safeParse({ steps: Array.from({ length: 31 }, () => step) }).success).toBe(false);
    expect(EditPlanInput.safeParse({ steps: [{ ...step, files: Array.from({ length: 51 }, () => "a") }] }).success).toBe(false);
    expect(EditPlanInput.safeParse({ steps: [{ ...step, description: "x".repeat(501) }] }).success).toBe(false);
    expect(EditPlanInput.safeParse({ map: { files: [{ path: "a", role: "delete" }], reason: "r" } }).success).toBe(false);
    expect(EditPlanInput.safeParse({ map: { files: [], reason: "" } }).success).toBe(false);
  });
});

describe("edit cases input", () => {
  it("accepts a list of cases with title, criterion and approach", () => {
    const cases = [{ title: "t", criterion: "c", approach: "a" }];
    expect(EditCasesInput.parse({ cases })).toEqual({ cases });
  });
  it("rejects a case missing its approach, and a body with no cases", () => {
    expect(EditCasesInput.safeParse({ cases: [{ title: "t", criterion: "c" }] }).success).toBe(false);
    expect(EditCasesInput.safeParse({}).success).toBe(false);
  });
});

describe("decision input: approve, request changes or reject, each with an optional comment", () => {
  it("takes the three decisions and the older sent_back", () => {
    for (const decision of ["approved", "changes_requested", "rejected", "sent_back"]) expect(DecisionInput.safeParse({ decision }).success).toBe(true);
    expect(DecisionInput.safeParse({ decision: "maybe" }).success).toBe(false);
  });
  it("reads the comment as the reason, from either field, bounded", () => {
    expect(DecisionInput.parse({ decision: "rejected", comment: "not now" })).toEqual({ decision: "rejected", comment: "not now" });
    expect(DecisionInput.safeParse({ decision: "rejected", comment: "x".repeat(2001) }).success).toBe(false);
    expect(DecisionInput.safeParse({ decision: "rejected", reason: "x".repeat(2001) }).success).toBe(false);
    expect(DecisionInput.safeParse({ decision: "rejected", reason: null, comment: null }).success).toBe(true);
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
  it("refuses an approver's name whose letters mix Latin, Cyrillic or Greek (a look-alike reads as another person), and takes a single script of any kind", () => {
    const name = (approver: string) => DecisionInput.safeParse({ decision: "approved", approver }).success;
    expect(name("ana")).toBe(true);
    expect(name("\u0430na")).toBe(false); // Cyrillic а + Latin na
    expect(name("\u03bflga")).toBe(false); // Greek omicron + Latin
    expect(name("\u0430\u043d\u0430")).toBe(true); // all Cyrillic
    expect(name("\u03b1\u03bb\u03b5\u03be")).toBe(true); // all Greek
    expect(name("\u7530\u4e2d")).toBe(true);
    expect(name("ana-maria o'neil 2nd")).toBe(true);
    expect(name("ana \u0430na")).toBe(false);
    expect(name("ana@corp.com")).toBe(true);
  });
  it("takes an approver by name, trimmed, and refuses an empty one", () => {
    expect(DecisionInput.parse({ decision: "approved", approver: "  ana " })).toEqual({ decision: "approved", approver: "ana" });
    expect(DecisionInput.safeParse({ decision: "approved", approver: "   " }).success).toBe(false);
  });
  it("leaves applyRules optional", () => {
    expect(DecisionInput.parse({ decision: "approved" })).toEqual({ decision: "approved" });
  });

  it("has no backlog: a new ticket's first state is draft, shown in Intake, eight columns in all", () => {
    expect(COLUMNS).toHaveLength(8);
    expect(COLUMNS[0]).toBe("Intake");
    expect(TaskState.options).not.toContain("backlog");
    expect(COLUMN_OF.draft).toBe("Intake");
  });
});
