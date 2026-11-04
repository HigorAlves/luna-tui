import { PACKS, PackId, RUNNING } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { packForState, packInfo, packStates } from "./packs.ts";

describe("packStates", () => {
  it("is the stage of the same name for a stage pack", () => {
    for (const id of ["setup", "triage", "test_design", "implementing", "verifying", "e2e", "evidence", "ci_watch", "reviewing", "addressing"] as const) {
      expect(packStates(id)).toEqual([id]);
    }
  });

  it("runs the planner in test_design, beside the pack of that name, which the pipeline still picks for the state", () => {
    expect(packStates("plan")).toEqual(["test_design"]);
    expect(packStates("plan_fast")).toEqual(["test_design"]);
    expect(packStates("code_map")).toEqual(["test_design"]);
    expect(packStates("test_design_fast")).toEqual(["test_design"]);
    expect(packStates("test_design")).toEqual(["test_design"]);
    expect(packForState("test_design")).toBe("test_design");
  });

  it("runs the memory review inside shipping, and the inbox and on-demand packs in no task state", () => {
    expect(packStates("reviewing_memory")).toEqual(["shipping"]);
    expect(packStates("slack_triage")).toEqual([]);
    expect(packStates("jira_intake")).toEqual([]);
    expect(packStates("chat_triage")).toEqual([]);
  });

  it("names only states in which a stage runs", () => {
    for (const id of PackId.options) for (const state of packStates(id)) expect(RUNNING.has(state)).toBe(true);
  });
});

describe("packInfo", () => {
  it("lists a pack's agent, kind, engines, limits and states", () => {
    expect(packInfo(PACKS.triage)).toEqual({
      id: "triage",
      agent: "triage-planner",
      kind: "agent",
      engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol"], fallback: ["codex:sol", "claude:opus"] },
      effort: PACKS.triage.effort,
      writable: false,
      maxTurns: PACKS.triage.maxTurns,
      timeoutMs: PACKS.triage.timeoutMs,
      states: ["triage"],
    });
    expect(packInfo(PACKS.evidence)).toMatchObject({ id: "evidence", agent: null, kind: "script" });
  });
});
