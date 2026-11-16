import { describe, expect, it } from "vitest";

import type { Check, MergedPr } from "../application/github.ts";
import { type ChangeRecord, changeRecord, evidencePage, evidencePath } from "./change-evidence.ts";

const pr = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 1,
  title: "Add export",
  url: "https://github.com/o/a/pull/1",
  body: "",
  author: "ann",
  mergedBy: "bob",
  mergedAt: "2026-01-05T10:00:00Z",
  mergeSha: "m1",
  baseRef: "main",
  headRef: "feat",
  headSha: "h1",
  closingIssues: [],
  reviews: [{ author: "cy", state: "APPROVED", commitId: "h1", submittedAt: "2026-01-04T10:00:00Z" }],
  ...over,
});
const ok: Check[] = [{ name: "ci", state: "SUCCESS", link: null }];
const input = { checks: ok, bypasses: [] as never[] | "unknown", jiraKey: null as string | null };

describe("changeRecord", () => {
  it("a PR approved by someone else on its head, with a closing issue and green checks, has no exception", () => {
    const r = changeRecord(pr({ closingIssues: [{ number: 7, url: "u" }] }), input);
    expect(r).toEqual({ number: 1, title: "Add export", url: "https://github.com/o/a/pull/1", author: "ann", mergedBy: "bob", mergedAt: "2026-01-05T10:00:00Z", approvedBy: ["cy"], ticket: "#7", checks: "green", bypass: "no", exceptions: [] });
  });

  it("a self-approval is no independent approval", () => {
    const r = changeRecord(pr({ reviews: [{ author: "ann", state: "APPROVED", commitId: "h1", submittedAt: null }, { author: "cy", state: "COMMENTED", commitId: "h1", submittedAt: null }] }), { ...input, jiraKey: "LUNA-1" });
    expect(r.approvedBy).toEqual([]);
    expect(r.exceptions).toEqual(["no_independent_approval"]);
  });

  it("an approval on an older commit is stale", () => {
    const r = changeRecord(pr({ reviews: [{ author: "cy", state: "APPROVED", commitId: "old", submittedAt: null }] }), { ...input, jiraKey: "LUNA-1" });
    expect(r.approvedBy).toEqual(["cy"]);
    expect(r.exceptions).toEqual(["stale_approval"]);
  });

  it("one approval on the head is enough, and approvers are distinct", () => {
    const r = changeRecord(
      pr({ reviews: [{ author: "cy", state: "APPROVED", commitId: "old", submittedAt: null }, { author: "cy", state: "APPROVED", commitId: "h1", submittedAt: null }, { author: "dee", state: "APPROVED", commitId: "old", submittedAt: null }] }),
      { ...input, jiraKey: "LUNA-1" },
    );
    expect(r.approvedBy).toEqual(["cy", "dee"]);
    expect(r.exceptions).toEqual([]);
  });

  it("stale approval is not judged without a head sha", () => {
    expect(changeRecord(pr({ headSha: null, reviews: [{ author: "cy", state: "APPROVED", commitId: "old", submittedAt: null }] }), { ...input, jiraKey: "LUNA-1" }).exceptions).toEqual([]);
  });

  it("no jira key and no closing issue is no ticket; a Jira key or a closing issue is the ticket", () => {
    expect(changeRecord(pr(), input)).toMatchObject({ ticket: null, exceptions: ["no_ticket"] });
    expect(changeRecord(pr(), { ...input, jiraKey: "LUNA-9" })).toMatchObject({ ticket: "LUNA-9", exceptions: [] });
    expect(changeRecord(pr({ closingIssues: [{ number: 7, url: "u" }, { number: 8, url: "u" }] }), { ...input, jiraKey: "LUNA-9" }).ticket).toBe("LUNA-9");
    expect(changeRecord(pr({ closingIssues: [{ number: 7, url: "u" }, { number: 8, url: "u" }] }), input).ticket).toBe("#7");
  });

  it("counts a reviewer only when their latest approval-or-objection is an approval: an approval later withdrawn by changes requested is no approval", () => {
    const review = (author: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING", at: string | null, commitId = "h1") => ({ author, state, commitId, submittedAt: at });
    const approved = (reviews: ReturnType<typeof review>[]) => changeRecord(pr({ reviews }), { ...input, jiraKey: "L-1" });
    const withdrawn = approved([review("bob", "APPROVED", "2026-01-04T10:00:00Z"), review("bob", "CHANGES_REQUESTED", "2026-01-04T11:00:00Z")]);
    expect(withdrawn.approvedBy).toEqual([]);
    expect(withdrawn.exceptions).toEqual(["no_independent_approval"]);
    expect(approved([review("bob", "APPROVED", "2026-01-04T10:00:00Z"), review("bob", "DISMISSED", "2026-01-04T11:00:00Z")]).approvedBy).toEqual([]);
    // Without timestamps the order the adapter returned them in stands.
    expect(approved([review("bob", "APPROVED", null), review("bob", "CHANGES_REQUESTED", null)]).approvedBy).toEqual([]);
    // A comment or a pending review is not an objection and not an approval: the approval before it stands.
    expect(approved([review("bob", "APPROVED", "2026-01-04T10:00:00Z"), review("bob", "COMMENTED", "2026-01-04T11:00:00Z"), review("bob", "PENDING", null)]).approvedBy).toEqual(["bob"]);
    // Changes requested, then approved: approved. The other reviewer's objection does not cancel it.
    const mixed = approved([review("bob", "CHANGES_REQUESTED", "2026-01-04T09:00:00Z"), review("bob", "APPROVED", "2026-01-04T10:00:00Z"), review("cy", "CHANGES_REQUESTED", "2026-01-04T10:30:00Z")]);
    expect(mixed.approvedBy).toEqual(["bob"]);
    expect(mixed.exceptions).toEqual([]);
    // The stale rule follows the approval that stands: bob's standing approval is on an old commit.
    expect(approved([review("bob", "APPROVED", "2026-01-04T10:00:00Z", "old")]).exceptions).toEqual(["stale_approval"]);
  });

  it("a check that ended red is red (every state the CI stage counts), a pending one is pending, not green; no checks is none", () => {
    for (const state of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE", "STALE"]) {
      const r = changeRecord(pr(), { ...input, jiraKey: "L-1", checks: [{ name: "ci", state: "SUCCESS", link: null }, { name: "x", state, link: null }] });
      expect(r.checks).toBe("red");
      expect(r.exceptions).toEqual(["checks_red"]);
    }
    expect(changeRecord(pr(), { ...input, jiraKey: "L-1", checks: [] })).toMatchObject({ checks: "none", exceptions: ["checks_not_green"] });
    const pending = changeRecord(pr(), { ...input, jiraKey: "L-1", checks: [{ name: "x", state: "PENDING", link: null }, { name: "y", state: "NEUTRAL", link: null }] });
    expect(pending).toMatchObject({ checks: "pending", exceptions: ["checks_not_green"] });
    expect(changeRecord(pr(), { ...input, jiraKey: "L-1", checks: [{ name: "x", state: "SUCCESS", link: null }, { name: "y", state: "NEUTRAL", link: null }] }).checks).toBe("green");
    expect(changeRecord(pr(), { ...input, jiraKey: "L-1", checks: [{ name: "x", state: "PENDING", link: null }, { name: "y", state: "FAILURE", link: null }] }).checks).toBe("red");
  });

  it("a bypass of the base branch ending at the merge commit is bypassed", () => {
    const bypass = { ref: "refs/heads/main", actor: "bob", at: "t", afterSha: "m1", ruleSuiteId: 1 };
    expect(changeRecord(pr(), { ...input, jiraKey: "L-1", bypasses: [bypass] })).toMatchObject({ bypass: "yes", exceptions: ["bypassed"] });
    expect(changeRecord(pr(), { ...input, jiraKey: "L-1", bypasses: [{ ...bypass, afterSha: "other" }, { ...bypass, ref: "refs/heads/dev" }] }).bypass).toBe("no");
  });

  it("bypasses the token cannot read are unknown, and no exception", () => {
    expect(changeRecord(pr(), { ...input, jiraKey: "L-1", bypasses: "unknown" })).toMatchObject({ bypass: "unknown", exceptions: [] });
  });
});

describe("evidencePath", () => {
  it("is the month's page under Compliance/Change-Management", () => {
    expect(evidencePath("2026-01")).toBe("Compliance/Change-Management/2026-01.md");
  });
});

describe("evidencePage", () => {
  const record = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({ ...changeRecord(pr(), { ...input, jiraKey: "L-1" }), ...over });
  const base = { repo: "o/a", period: "2026-01", bypassUnknown: false, explanations: new Map<string, string>(), generatedAt: "2026-02-01T00:00:00Z" };

  it("says no PRs were merged for an empty month", () => {
    const page = evidencePage({ ...base, records: [] });
    expect(page).toContain("# Change management evidence: o/a, 2026-01");
    expect(page).toContain("No PRs were merged in this period.");
    expect(page).not.toContain("| PR |");
  });

  it("lists the controls, counts, one row per PR and no exceptions section content for a clean month", () => {
    const page = evidencePage({ ...base, records: [record()] });
    expect(page).toContain("Generated 2026-02-01T00:00:00Z");
    expect(page).toContain("SOC2 CC8.1");
    expect(page).toContain("HIPAA 164.308(a)(1)(ii)(D)");
    expect(page).toContain("PRs merged: 1");
    expect(page).toContain("PRs with exceptions: 0");
    expect(page).toContain("| PR | Author | Merged by | Approved by | Ticket | Checks | Bypass | Result |");
    expect(page).toContain("| [#1 Add export](https://github.com/o/a/pull/1) | ann | bob | cy | L-1 | green | no | ok |");
    expect(page).toContain("computed from GitHub");
  });

  it("an exception shows in the result and under Exceptions with its explanation, or a note that there is none", () => {
    const records = [record({ exceptions: ["no_ticket", "checks_red"], ticket: null, checks: "red" }), record({ number: 2, title: "Two", url: "https://github.com/o/a/pull/2", exceptions: ["bypassed"], bypass: "yes" })];
    const page = evidencePage({ ...base, records, explanations: new Map([["1:no_ticket", "Hotfix, ticket filed after."]]) });
    expect(page).toContain("PRs with exceptions: 2");
    expect(page).toContain("| no_ticket, checks_red |");
    expect(page).toContain("## Exceptions");
    expect(page).toContain("Hotfix, ticket filed after.");
    expect(page.match(/No explanation recorded\./g)).toHaveLength(2);
  });

  it("notes that bypasses could not be read when the token cannot", () => {
    expect(evidencePage({ ...base, records: [record({ bypass: "unknown" })], bypassUnknown: true })).toContain("could not be read with the token");
    expect(evidencePage({ ...base, records: [record()] })).not.toContain("could not be read with the token");
  });

  it("escapes pipes and newlines in a title", () => {
    const page = evidencePage({ ...base, records: [record({ title: "a | b\nc" })] });
    expect(page).toContain("[#1 a \\| b c]");
  });
});
