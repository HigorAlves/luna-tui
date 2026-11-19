import { PACKS, PackId, RUNNING, RUN_OR_GATE } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { packForState, packInfo, packStates, soleAgentPackForState } from "./packs.ts";

describe("soleAgentPackForState", () => {
  it("names the pack of a state that runs exactly one agent pack", () => {
    expect(soleAgentPackForState("setup")).toBe("setup");
    expect(soleAgentPackForState("verifying")).toBe("verifying");
  });

  it("names none for a state that several agent packs run in", () => {
    expect(soleAgentPackForState("test_design")).toBeNull();
    expect(soleAgentPackForState("implementing")).toBeNull();
    expect(soleAgentPackForState("evidence")).toBeNull();
  });

  it("leaves out the council packs, which never decide a stage's outcome", () => {
    expect(soleAgentPackForState("triage")).toBe("triage");
  });

  it("keeps e2e the sole agent pack of its state: the audit is a sub-run", () => {
    expect(packStates("a11y_audit")).toEqual([]);
    expect(soleAgentPackForState("e2e")).toBe("e2e");
  });

  it("keeps test_design unattributed: the planner, the test designer and the code map all decide there", () => {
    expect(soleAgentPackForState("test_design")).toBeNull();
  });

  it("agrees with the agent packs the registry says run in the state", () => {
    for (const state of ["setup", "test_design", "implementing", "triage", "verifying", "e2e", "evidence", "ci_watch", "reviewing", "addressing", "awaiting_ship"] as const) {
      const agents = PackId.options.filter((id) => PACKS[id].kind !== "decision" && !["council_security", "council_second", "question_council"].includes(id) && packStates(id).includes(state));
      expect(soleAgentPackForState(state)).toBe(agents.length === 1 ? agents[0] : null);
    }
  });
});

describe("packStates", () => {
  it("is the stage of the same name for a stage pack", () => {
    for (const id of ["setup", "triage", "test_design", "implementing", "verifying", "e2e", "evidence", "ci_watch", "reviewing", "addressing"] as const) {
      expect(packStates(id)).toEqual([id]);
    }
  });

  it("runs the planner in test_design, beside the pack of that name, which the pipeline still picks for the state", () => {
    expect(packStates("plan")).toEqual(["test_design"]);
    expect(packStates("plan_fast")).toEqual(["test_design"]);
    expect(packStates("build_tests")).toEqual(["implementing"]);
    expect(packStates("code_map")).toEqual(["test_design"]);
    expect(packStates("test_design_fast")).toEqual(["test_design"]);
    expect(packStates("test_design")).toEqual(["test_design"]);
    expect(packForState("test_design")).toBe("test_design");
  });

  it("runs the four video packs inside evidence, beside the pack of that name, which the pipeline still picks for the state", () => {
    for (const id of ["video_script", "recording", "video_qa", "video_fix"] as const) expect(packStates(id)).toEqual(["evidence"]);
    expect(packForState("evidence")).toBe("evidence");
  });

  it("runs the memory review in its own state, and the inbox and on-demand packs in no task state", () => {
    expect(packStates("reviewing_memory")).toEqual(["reviewing_memory"]);
    expect(packStates("slack_triage")).toEqual([]);
    expect(packStates("jira_intake")).toEqual([]);
    expect(packStates("chat_triage")).toEqual([]);
  });

  it("names only states in which a stage runs", () => {
    for (const id of PackId.options) for (const state of packStates(id)) expect(RUNNING.has(state) || RUN_OR_GATE.has(state)).toBe(true);
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
