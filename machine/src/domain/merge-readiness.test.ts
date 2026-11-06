import { describe, expect, it } from "vitest";

import { inFreeze, mergeReadiness, parseDependencies } from "./merge-readiness.ts";
import type { PrFacts } from "./pull-request.ts";

const HEAD = "9c1f0e2a7b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
const NOW = new Date("2026-11-04T12:00:00Z");

const pr = (over: Partial<PrFacts> = {}): PrFacts => ({
  repo: "o/a",
  number: 12,
  title: "Export CSV",
  url: "https://github.com/o/a/pull/12",
  author: "me",
  mine: true,
  reviewRequested: false,
  isDraft: false,
  headRef: "hardness/t1",
  baseRef: "main",
  fromFork: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  checks: { state: "success", passed: 2, total: 2, failed: [], all: [] },
  unresolvedThreads: 0,
  updatedAt: "2026-11-04T10:00:00Z",
  headSha: HEAD,
  headCommittedAt: "2026-11-03T10:00:00Z",
  nodeId: "PR_1",
  body: null,
  ...over,
});

const input = (over: Partial<Parameters<typeof mergeReadiness>[0]> = {}): Parameters<typeof mergeReadiness>[0] => ({
  pr: pr(),
  packSha: HEAD,
  policy: { autoMerge: "low", freeze: [] },
  risk: "low",
  shipApprover: null,
  now: NOW,
  dependencies: [],
  owners: { missing: [], unresolved: [] },
  ...over,
});

describe("mergeReadiness", () => {
  it("is ready, and may merge by itself, for a clean approved green PR the pack describes, with every owner approving", () => {
    expect(mergeReadiness(input())).toMatchObject({ ready: true, blockers: [], canAutoMerge: true });
  });

  it("does not count a PR with no CI as blocked, and takes no owners file as nothing to check", () => {
    const out = mergeReadiness(input({ pr: pr({ checks: { state: "none", passed: 0, total: 0, failed: [], all: [] }, reviewDecision: null }), owners: null }));
    expect(out.ready).toBe(true);
  });

  const blocked: Array<[string, Partial<Parameters<typeof mergeReadiness>[0]>, string]> = [
    ["red CI", { pr: pr({ checks: { state: "failure", passed: 1, total: 2, failed: [], all: [] } }) }, "CI is red"],
    ["pending CI", { pr: pr({ checks: { state: "pending", passed: 1, total: 2, failed: [], all: [] } }) }, "CI is pending"],
    ["a conflict", { pr: pr({ mergeable: "CONFLICTING", mergeState: "DIRTY" }) }, "conflicts with the base"],
    ["GitHub blocking", { pr: pr({ mergeState: "BLOCKED" }) }, "GitHub blocks the merge (BLOCKED)"],
    ["changes requested", { pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) }, "changes requested"],
    ["a missing approval", { pr: pr({ reviewDecision: "REVIEW_REQUIRED" }) }, "approval required"],
    ["a draft", { pr: pr({ isDraft: true }) }, "draft"],
    ["a missing owner approval", { owners: { missing: [{ path: "src/a.ts", owners: ["@ana", "@acme/core"] }], unresolved: [] } }, "no owner of src/a.ts approved (@ana, @acme/core)"],
    ["an unresolved owner", { owners: { missing: [], unresolved: ["@acme/ghosts"] } }, "owner @acme/ghosts cannot be resolved"],
    ["a pack that shows another commit", { packSha: "1111111aaaa" }, "the pack shows 1111111, the head is 9c1f0e2"],
    ["a freeze", { policy: { autoMerge: "low", freeze: [{ from: "2026-11-04T00:00:00Z", to: "2026-11-05T00:00:00Z", reason: "release week" }] } }, "freeze: release week until 2026-11-05T00:00:00Z"],
    ["a dependency still open", { dependencies: [{ number: 7, merged: false, closed: false }] }, "blocked by #7"],
    ["a head fifteen days old", { pr: pr({ headCommittedAt: "2026-10-20T10:00:00Z" }) }, "the head is 15 days old (limit 14)"],
  ];

  it.each(blocked)("is blocked by %s alone, and says so in plain words", (_name, over, blocker) => {
    const out = mergeReadiness(input(over));
    expect(out.blockers).toEqual([blocker]);
    expect(out.ready).toBe(false);
    expect(out.canAutoMerge).toBe(false);
    expect(out.reason).toContain(blocker);
  });

  it("takes the stale limit from the repo's `ship.stale_days`", () => {
    const old = { pr: pr({ headCommittedAt: "2026-10-20T10:00:00Z" }) };
    expect(mergeReadiness(input({ ...old, staleDays: 20 })).blockers).toEqual([]);
    expect(mergeReadiness(input({ ...old, staleDays: 10 })).blockers).toEqual(["the head is 15 days old (limit 10)"]);
  });

  it("is never ready with no evidence pack, and never for a PR that changes CODEOWNERS", () => {
    expect(mergeReadiness(input({ packSha: null })).blockers).toEqual(["no evidence pack"]);
    expect(mergeReadiness(input({ changesCodeowners: true }))).toMatchObject({ ready: false, canAutoMerge: false, blockers: ["changes CODEOWNERS: a person merges"] });
  });

  it("treats a freeze window with an unreadable date as frozen, and refuses a PR listing too many dependencies", () => {
    const bad = mergeReadiness(input({ policy: { autoMerge: "low", freeze: [{ from: "soon", to: "2026-11-05T00:00:00Z", reason: "x" }] } }));
    expect(bad.blockers).toEqual(["freeze window has an unreadable date"]);
    expect(mergeReadiness(input({ dependenciesListed: 11 })).blockers).toEqual(["too many dependencies listed (11)"]);
    expect(mergeReadiness(input({ dependenciesListed: 10 })).ready).toBe(true);
  });

  it("lets a merged or closed dependency go, and lists every blocker together", () => {
    expect(mergeReadiness(input({ dependencies: [{ number: 7, merged: true, closed: true }, { number: 8, merged: false, closed: true }] })).ready).toBe(true);
    const out = mergeReadiness(input({ pr: pr({ isDraft: true, reviewDecision: "CHANGES_REQUESTED" }) }));
    expect(out.blockers).toEqual(["draft", "changes requested"]);
  });

  describe("canAutoMerge", () => {
    const cases: Array<[string, "off" | "low" | "medium", string | null, boolean]> = [
      ["low", "off", null, false],
      ["low", "low", null, true],
      ["low", "medium", null, true],
      ["medium", "off", null, false],
      ["medium", "low", null, false],
      ["medium", "medium", null, true],
      ["high", "medium", null, false],
      ["high", "off", "ana", false],
      ["high", "low", "ana", true],
      ["high", "medium", "ana", true],
    ];
    it.each(cases)("%s risk, auto_merge %s, ship approver %s: %s", (risk, autoMerge, shipApprover, expected) => {
      const out = mergeReadiness(input({ risk: risk as "low", policy: { autoMerge, freeze: [] }, shipApprover }));
      expect(out.ready).toBe(true);
      expect(out.canAutoMerge).toBe(expected);
    });

    it("never merges a PR that is not ready, whatever the policy", () => {
      expect(mergeReadiness(input({ pr: pr({ isDraft: true }), policy: { autoMerge: "medium", freeze: [] } })).canAutoMerge).toBe(false);
    });

    it("says why a ready PR waits for a person", () => {
      expect(mergeReadiness(input({ policy: { autoMerge: "off", freeze: [] } })).reason).toMatch(/auto-merge/);
      expect(mergeReadiness(input({ risk: "high" })).reason).toMatch(/ship approver/);
    });
  });
});

describe("parseDependencies", () => {
  it("reads Depends on and Blocked by, any case, deduped, in order", () => {
    expect(parseDependencies("Depends on #12\nblocked by #3, BLOCKED BY #12\nSee #99")).toEqual([12, 3]);
    expect(parseDependencies(null)).toEqual([]);
    expect(parseDependencies("nothing here")).toEqual([]);
  });
});

describe("inFreeze", () => {
  const freeze = [
    { from: "2026-11-04T00:00:00Z", to: "2026-11-05T00:00:00Z", reason: "a" },
    { from: "not a date", to: "2026-11-05T00:00:00Z", reason: "b" },
  ];
  it("returns the window that holds now, a window with a bad date as frozen, and none once they are past", () => {
    expect(inFreeze(freeze, NOW)?.reason).toBe("a");
    expect(inFreeze([freeze[1]!], NOW)?.reason).toBe("b");
    expect(inFreeze([freeze[0]!], new Date("2026-11-05T00:00:00Z"))).toBeNull();
    expect(inFreeze([freeze[0]!], new Date("2026-11-03T23:59:59Z"))).toBeNull();
    expect(inFreeze([], NOW)).toBeNull();
  });
});

describe("mergeReadiness after a fix the loop made", () => {
  it("wants an approval on the fix's own commit before the machine merges, and says which sha has none", () => {
    const waiting = mergeReadiness(input({ fixApproval: { approved: false } }));
    expect(waiting).toMatchObject({ ready: false, canAutoMerge: false });
    expect(waiting.blockers).toEqual([`the fix at ${HEAD.slice(0, 7)} has no approval on it`]);
    expect(mergeReadiness(input({ fixApproval: { approved: true } }))).toMatchObject({ ready: true, canAutoMerge: true });
    expect(mergeReadiness(input({ fixApproval: null }))).toMatchObject({ ready: true });
  });
});

describe("mergeReadiness: a person must have looked", () => {
  const ready = (over: Partial<Parameters<typeof mergeReadiness>[0]> = {}) => mergeReadiness(input({ pr: pr({ reviewDecision: null }), ...over }));

  it("does not let the machine merge a PR no person approved or looked at, and says an approving review is needed", () => {
    const out = ready({ humanLook: false });
    expect(out.ready).toBe(true);
    expect(out.canAutoMerge).toBe(false);
    expect(out.reason).toMatch(/approving review is needed/);
  });

  it("is satisfied by an approved awaiting_ship gate or by an approving review", () => {
    expect(ready({ humanLook: true }).canAutoMerge).toBe(true);
    expect(mergeReadiness(input({ pr: pr({ reviewDecision: "APPROVED" }), humanLook: false })).canAutoMerge).toBe(true);
  });

  it("still never merges a high-risk pack with no ship approver, whatever the look", () => {
    const out = mergeReadiness(input({ risk: "high", humanLook: true, policy: { autoMerge: "medium", freeze: [] }, shipApprover: null }));
    expect(out.canAutoMerge).toBe(false);
  });
});

