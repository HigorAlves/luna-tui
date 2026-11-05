import { describe, expect, it } from "vitest";

import { stageFactRows } from "./stage-facts.ts";

const finding = (severity: string) => ({ path: "a", line: 1, severity, title: "t", body: "b", confidence: 1 });

describe("stageFactRows", () => {
  it("counts verifying's findings by severity level, on a pass and on a fail", () => {
    const detail = { findings: [finding("bug"), finding("test"), finding("nit"), finding("security")] };
    // bug and security are blockers (2), test is should_fix (1), nit (1)
    expect(stageFactRows("verifying", "failed", { detail })).toEqual([{ kind: "verify.findings", payload: { count: 4, blockers: 2, shouldFix: 1, nits: 1 } }]);
    expect(stageFactRows("verifying", "passed", { detail: {} })).toEqual([{ kind: "verify.findings", payload: { count: 0, blockers: 0, shouldFix: 0, nits: 0 } }]);
    expect(stageFactRows("verifying", "aborted", { detail })).toEqual([]);
  });

  it("reads the CI watch's settle from its checks", () => {
    const checks = [{ name: "a", state: "SUCCESS" }, { name: "b", state: "FAILURE" }, { name: "c", state: "SUCCESS" }];
    expect(stageFactRows("ci_watch", "failed", { detail: { checks } })).toEqual([{ kind: "ci.status", payload: { state: "red", total: 3, failed: 1 } }]);
    expect(stageFactRows("ci_watch", "failed", { detail: { checks, class: "flake" } })).toEqual([{ kind: "ci.status", payload: { state: "red", total: 3, failed: 1, class: "flake" } }]);
    expect(stageFactRows("ci_watch", "passed", { detail: { checks: checks.slice(0, 1) } })).toEqual([{ kind: "ci.status", payload: { state: "green", total: 1, failed: 0 } }]);
    expect(stageFactRows("ci_watch", "failed", { detail: { error: "CI did not settle in 45m" } })).toEqual([]);
  });

  it("says when evidence ingested media, only on a pass with files", () => {
    expect(stageFactRows("evidence", "passed", { detail: { artifactCount: 3 } })).toEqual([{ kind: "evidence.media_ready", payload: { count: 3 } }]);
    expect(stageFactRows("evidence", "passed", { detail: { artifactCount: 0 } })).toEqual([]);
    expect(stageFactRows("evidence", "failed", { detail: { artifactCount: 3 } })).toEqual([]);
  });

  it("says when triage took the fast lane", () => {
    expect(stageFactRows("triage", "passed", { detail: { outcome: "fast_lane" } })).toEqual([{ kind: "card.fast_lane", payload: {} }]);
    expect(stageFactRows("triage", "passed", { detail: { outcome: "plan" } })).toEqual([]);
  });

  it("has nothing to say about other stages", () => {
    expect(stageFactRows("implementing", "passed", { detail: {} })).toEqual([]);
  });
});
