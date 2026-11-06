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
  now: NOW,
  dependencies: [],
  owners: { missing: [], unresolved: [] },
  review: { required: true, by: "ruleset" },
  approvedOnHead: true,
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
      // the third column is the head a person's ship approval was for: only a High-risk card cannot merge without one
      ["low", "off", null, false],
      ["low", "low", null, true],
      ["low", "medium", null, true],
      ["medium", "off", null, false],
      ["medium", "low", null, false],
      ["medium", "medium", null, true],
      ["high", "medium", null, false],
      ["high", "off", HEAD, false],
      ["high", "low", HEAD, true],
      ["high", "medium", HEAD, true],
    ];
    it.each(cases)("%s risk, auto_merge %s, ship approval for %s: %s", (risk, autoMerge, approvedHead, expected) => {
      const out = mergeReadiness(input({ risk: risk as "low", policy: { autoMerge, freeze: [] }, shipApproval: approvedHead ? { head: approvedHead } : null }));
      expect(out.ready).toBe(true);
      expect(out.canAutoMerge).toBe(expected);
    });

    it("never merges a PR that is not ready, whatever the policy", () => {
      expect(mergeReadiness(input({ pr: pr({ isDraft: true }), policy: { autoMerge: "medium", freeze: [] } })).canAutoMerge).toBe(false);
    });

    it("says why a ready PR waits for a person", () => {
      expect(mergeReadiness(input({ policy: { autoMerge: "off", freeze: [] } })).reason).toMatch(/auto-merge/);
      expect(mergeReadiness(input({ risk: "high" })).reason).toMatch(/release approval/);
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
  it("does not let the machine merge a PR with no approval on the head, and says which sha has none", () => {
    const out = mergeReadiness(input({ pr: pr({ reviewDecision: null }), approvedOnHead: false }));
    expect(out).toMatchObject({ ready: true, canAutoMerge: false });
    expect(out.reason).toMatch(/no approval on 9c1f0e2/);
  });
  it("is not satisfied by GitHub's reviewDecision or an approved preview gate alone", () => {
    expect(mergeReadiness(input({ pr: pr({ reviewDecision: "APPROVED" }), approvedOnHead: false })).canAutoMerge).toBe(false);
    expect(mergeReadiness(input({ approvedOnHead: true })).canAutoMerge).toBe(true);
  });
});

describe("auto-merge under the review rule (D4)", () => {
  const required = { required: true as const, by: "ruleset" };
  const base = (over: Partial<Parameters<typeof mergeReadiness>[0]> = {}) => input({ policy: { autoMerge: "medium_when_review_required", freeze: [] }, review: required, approvedOnHead: true, ...over });
  it("the default merges Medium risk only where a review is required and one is on the head", () => {
    expect(mergeReadiness(base({ risk: "medium" })).canAutoMerge).toBe(true);
    expect(mergeReadiness(base({ risk: "medium", approvedOnHead: false })).reason).toMatch(/no approval on 9c1f0e2/);
    expect(mergeReadiness(base({ risk: "medium", review: { required: false } })).reason).toBe("ready; this repository requires no review, so a person merges it");
    const unreadable = mergeReadiness(base({ risk: "medium", review: { required: null, why: "403" } }));
    expect(unreadable.canAutoMerge).toBe(false);
    expect(unreadable.reason).toBe("ready; whether a review is required could not be read (403), so a person merges it");
  });
  it("no mode merges a PR that has no approval on the head: GitHub's reviewDecision alone is not enough", () => {
    for (const autoMerge of ["low", "medium", "medium_when_review_required"] as const) {
      expect(mergeReadiness(base({ policy: { autoMerge, freeze: [] }, approvedOnHead: false, pr: pr({ reviewDecision: "APPROVED" }) })).canAutoMerge).toBe(false);
    }
  });
  it("off never merges; low merges only Low risk; medium merges Low and Medium on an approval; High is never merged without a ship approval", () => {
    expect(mergeReadiness(base({ policy: { autoMerge: "off", freeze: [] } })).canAutoMerge).toBe(false);
    expect(mergeReadiness(base({ policy: { autoMerge: "low", freeze: [] }, risk: "medium" })).canAutoMerge).toBe(false);
    expect(mergeReadiness(base({ policy: { autoMerge: "low", freeze: [] }, review: { required: false } })).canAutoMerge).toBe(true);
    expect(mergeReadiness(base({ policy: { autoMerge: "medium", freeze: [] }, risk: "medium", review: { required: false } })).canAutoMerge).toBe(true);
    expect(mergeReadiness(base({ policy: { autoMerge: "medium", freeze: [] }, risk: "high" })).canAutoMerge).toBe(false);
  });
});

describe("the checklist and the ship approval (slice 4)", () => {
  const IDS = ["pack", "draft", "ci", "conflicts", "approvals", "owners", "codeowners_change", "fix_approval", "evidence_head", "freeze", "blocked", "stale"];
  const withMode = (autoMerge: "off" | "low" | "medium" | "medium_when_review_required", over: Partial<Parameters<typeof mergeReadiness>[0]> = {}) => input({ policy: { autoMerge, freeze: [] }, ...over });

  it("lists the twelve items in a fixed order, all ok for a clean PR", () => {
    const out = mergeReadiness(input());
    expect(out.checklist.map((i) => i.id)).toEqual(IDS);
    expect(out.checklist.every((i) => i.ok)).toBe(true);
  });

  it("marks the item that is not ok, with its detail, and blockers are those details", () => {
    const out = mergeReadiness(input({ pr: pr({ isDraft: true, checks: { state: "failure", passed: 0, total: 1, failed: [], all: [] } }), packSha: "1111111aaaa" }));
    const bad = out.checklist.filter((i) => !i.ok);
    expect(bad.map((i) => i.id)).toEqual(["draft", "ci", "evidence_head"]);
    expect(out.blockers).toEqual(["draft", "CI is red", "the pack shows 1111111, the head is 9c1f0e2"]);
    expect(out.checklist.find((i) => i.id === "ci")).toMatchObject({ ok: false, detail: "CI is red" });
  });

  it("asks a person for a High-risk card once ready, never before", () => {
    expect(mergeReadiness(withMode("medium_when_review_required", { risk: "high" })).needsShipApproval).toBe(true);
    expect(mergeReadiness(withMode("medium_when_review_required", { risk: "high", pr: pr({ isDraft: true }) })).needsShipApproval).toBe(false);
  });

  it("does not ask with auto_merge off", () => {
    expect(mergeReadiness(withMode("off", { risk: "high" })).needsShipApproval).toBe(false);
  });

  it("asks for low or medium modes when the risk is covered and nobody approved the head", () => {
    expect(mergeReadiness(withMode("low", { approvedOnHead: false })).needsShipApproval).toBe(true);
    expect(mergeReadiness(withMode("low", { approvedOnHead: true })).needsShipApproval).toBe(false);
    expect(mergeReadiness(withMode("low", { risk: "medium", approvedOnHead: false })).needsShipApproval).toBe(false);
    expect(mergeReadiness(withMode("medium", { risk: "medium", approvedOnHead: false })).needsShipApproval).toBe(true);
    expect(mergeReadiness(withMode("medium_when_review_required", { approvedOnHead: false })).needsShipApproval).toBe(false);
  });

  it("merges a High-risk card only with a ship approval for the head, and an approval on the head where a review is required", () => {
    const base = { risk: "high" as const, shipApproval: { head: HEAD } };
    expect(mergeReadiness(withMode("medium_when_review_required", base)).canAutoMerge).toBe(true);
    expect(mergeReadiness(withMode("medium_when_review_required", { ...base, approvedOnHead: false })).canAutoMerge).toBe(false);
    expect(mergeReadiness(withMode("medium_when_review_required", { ...base, approvedOnHead: false, review: { required: false } })).canAutoMerge).toBe(true);
    expect(mergeReadiness(withMode("medium_when_review_required", { ...base, shipApproval: { head: "1111111aaaa" } })).canAutoMerge).toBe(false);
    expect(mergeReadiness(withMode("off", base)).canAutoMerge).toBe(false);
    expect(mergeReadiness(withMode("medium_when_review_required", { risk: "high" })).canAutoMerge).toBe(false);
  });

  it("low and medium merge on a ship approval for the head in place of an approval on the head", () => {
    expect(mergeReadiness(withMode("low", { approvedOnHead: false, shipApproval: { head: HEAD } })).canAutoMerge).toBe(true);
    expect(mergeReadiness(withMode("low", { approvedOnHead: false, shipApproval: { head: "1111111aaaa" } })).canAutoMerge).toBe(false);
    expect(mergeReadiness(withMode("medium_when_review_required", { approvedOnHead: false, shipApproval: { head: HEAD } })).canAutoMerge).toBe(false);
  });
});
