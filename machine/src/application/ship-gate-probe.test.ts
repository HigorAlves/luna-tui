import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "../domain/policy.ts";
import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { fakeGitHub } from "../test/github.ts";
import { emptyCursor, saveCursor } from "./ship-cursor.ts";
import { shipGateProbe } from "./ship-gate-probe.ts";

const HEAD = "a".repeat(40);
const MOVED = "d".repeat(40);
const open = { merged: false, mergedSha: null, state: "open" as const, mergedAt: null };
const node = (checks = "SUCCESS", oid = HEAD) => ({
  id: "PR_1", number: 3, title: "t", body: null, url: "https://github.com/a/b/pull/3", isDraft: false, updatedAt: "2026-11-04T11:00:00Z", baseRefName: "main", headRefName: "hardness/t1",
  author: { login: "me" }, headRepository: { nameWithOwner: "a/b" }, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { oid, committedDate: new Date().toISOString(), statusCheckRollup: { state: checks, contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: checks, detailsUrl: null }] } } } }] },
});
const pack = { summary: "s", format: "text", scenarios: [], findings: [], outOfMap: [], risk: "high", rollback: "r", howToVerify: "h", commitSha: HEAD, media: [], at: "2026-11-04T00:00:00.000Z" };
const task = { id: "t1", repoPath: "/repo", branch: "hardness/t1" } as unknown as TaskRow;
const gate = (head = HEAD) => ({ kind: "awaiting_ship", decision: null, requested: { gate: "ship_approval", head } }) as unknown as ApprovalRow;

async function probeWith(github: Parameters<typeof fakeGitHub>[0], withCursor = true) {
  const stateDir = await mkdtemp(join(tmpdir(), "probe-"));
  if (withCursor) await saveCursor(stateDir, "t1", emptyCursor({ slug: "a/b", number: 3 }));
  const gh = fakeGitHub({ viewer: async () => ({ login: "me", teams: [] }), reviewRule: async () => ({ source: "ruleset" as const, approvals: 1, codeOwners: false }), prReviews: async () => [], prFiles: async () => [], fileAtRef: async () => null, prHeadSha: async () => HEAD, prMerged: async () => open, prFacts: async () => node() as never, ...github });
  return shipGateProbe({ github: gh, policies: { for: async () => DEFAULT_POLICY }, evidence: { load: async () => pack as never }, stateDir });
}

describe("shipGateProbe", () => {
  it("keeps a gate whose head is the head and whose checklist still passes", async () => {
    expect(await (await probeWith({}))(task, gate())).toBe("keep");
  });
  it("says merged for a PR GitHub shows merged", async () => {
    expect(await (await probeWith({ prMerged: async () => ({ ...open, merged: true, state: "closed" as const, mergedSha: "m" }) }))(task, gate())).toBe("merged");
  });
  it("withdraws when the head moved", async () => {
    expect(await (await probeWith({ prFacts: async () => node("SUCCESS", MOVED) as never, prHeadSha: async () => MOVED }))(task, gate())).toBe("withdraw");
  });
  it("withdraws when the checklist no longer passes", async () => {
    expect(await (await probeWith({ prFacts: async () => node("FAILURE") as never }))(task, gate())).toBe("withdraw");
  });
  it("keeps when there is no cursor or GitHub shows no PR: nothing is withdrawn on a guess", async () => {
    expect(await (await probeWith({}, false))(task, gate())).toBe("keep");
    expect(await (await probeWith({ prFacts: async () => null }))(task, gate())).toBe("keep");
  });
});
