import { describe, expect, it } from "vitest";

import { parseCodeowners } from "./codeowners.ts";
import { approvedOnHead, approversByComment, approversOnHead, isShipCommand, reviewRequirement } from "./review-rule.ts";

const owners = (text: string | null) => (text === null ? null : parseCodeowners(text));

describe("reviewRequirement", () => {
  it("a ruleset or branch protection that asks for an approval requires a review", () => {
    expect(reviewRequirement({ rule: { source: "ruleset", approvals: 1, codeOwners: false }, seenRequired: false, owners: null, paths: ["a.ts"] })).toEqual({ required: true, by: "a ruleset" });
    expect(reviewRequirement({ rule: { source: "branch_protection", approvals: 2, codeOwners: false }, seenRequired: false, owners: null, paths: ["a.ts"] })).toEqual({ required: true, by: "branch protection" });
  });

  it("a code owner's review alone requires one", () => {
    expect(reviewRequirement({ rule: { source: "ruleset", approvals: 0, codeOwners: true }, seenRequired: false, owners: null, paths: [] })).toMatchObject({ required: true });
  });

  it("a pull-request rule asking for no approval and no owner requires nothing", () => {
    expect(reviewRequirement({ rule: { source: "ruleset", approvals: 0, codeOwners: false }, seenRequired: false, owners: null, paths: ["a.ts"] })).toEqual({ required: false });
  });

  it("no rule and no CODEOWNERS is not required", () => {
    expect(reviewRequirement({ rule: { source: "none" }, seenRequired: false, owners: null, paths: ["a.ts"] })).toEqual({ required: false });
  });

  it("GitHub having answered REVIEW_REQUIRED for this PR is enough, even when the rule is unreadable", () => {
    expect(reviewRequirement({ rule: { source: "unreadable", why: "403" }, seenRequired: true, owners: null, paths: ["a.ts"] })).toEqual({ required: true, by: "GitHub's own review requirement for this PR" });
  });

  it("CODEOWNERS counts only when it names an owner for every changed path", () => {
    const text = "src/ @ana\n";
    expect(reviewRequirement({ rule: { source: "none" }, seenRequired: false, owners: owners(text), paths: ["src/a.ts", "src/b/c.ts"] })).toEqual({ required: true, by: "CODEOWNERS" });
    expect(reviewRequirement({ rule: { source: "none" }, seenRequired: false, owners: owners(text), paths: ["src/a.ts", "README.md"] })).toEqual({ required: false });
  });

  it("an empty change is never covered by CODEOWNERS", () => {
    expect(reviewRequirement({ rule: { source: "none" }, seenRequired: false, owners: owners("* @ana\n"), paths: [] })).toEqual({ required: false });
  });

  it("an unreadable rule with nothing else is null with the reason", () => {
    expect(reviewRequirement({ rule: { source: "unreadable", why: "protection not readable (403)" }, seenRequired: false, owners: null, paths: ["a.ts"] })).toEqual({ required: null, why: "protection not readable (403)" });
  });

  it("an unreadable rule with a CODEOWNERS that covers every path is required", () => {
    expect(reviewRequirement({ rule: { source: "unreadable", why: "x" }, seenRequired: false, owners: owners("* @ana\n"), paths: ["a.ts"] })).toEqual({ required: true, by: "CODEOWNERS" });
  });
});

describe("approvedOnHead", () => {
  const HEAD = "a".repeat(40);
  const OLD = "b".repeat(40);
  const review = (author: string, state: string, commitId: string | null, association: string | null = "COLLABORATOR") => ({ author, state, commitId, association });
  it("counts an APPROVED review that is its author's latest, on the head, by an owner, member or collaborator who is not the token's login", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(approvedOnHead([review("ana", "APPROVED", HEAD, association)], HEAD, "me")).toBe(true);
  });
  it("does not count an approval on an older commit, a stranger's, the machine's own, or one a later review by the same author cancelled", () => {
    expect(approvedOnHead([review("ana", "APPROVED", OLD)], HEAD, "me")).toBe(false);
    expect(approvedOnHead([review("eve", "APPROVED", HEAD, "NONE")], HEAD, "me")).toBe(false);
    expect(approvedOnHead([review("eve", "APPROVED", HEAD, "CONTRIBUTOR")], HEAD, "me")).toBe(false);
    expect(approvedOnHead([review("Me", "APPROVED", HEAD)], HEAD, "me")).toBe(false);
    expect(approvedOnHead([review("ana", "APPROVED", HEAD), review("ana", "CHANGES_REQUESTED", HEAD)], HEAD, "me")).toBe(false);
    expect(approvedOnHead([review("ana", "APPROVED", null)], HEAD, "me")).toBe(false);
  });
  it("fails closed without a head or without knowing the token's login", () => {
    expect(approvedOnHead([review("ana", "APPROVED", HEAD)], null, "me")).toBe(false);
    expect(approvedOnHead([review("ana", "APPROVED", HEAD)], HEAD, null)).toBe(false);
  });
});

describe("approversOnHead", () => {
  const HEAD = "a".repeat(40);
  const OLD = "b".repeat(40);
  const review = (author: string, state: string, commitId: string | null, association: string | null = "COLLABORATOR") => ({ author, state, commitId, association });
  it("lists the trusted logins whose latest verdict on the head is an approval, never the machine's own", () => {
    const reviews = [review("ana", "APPROVED", HEAD), review("bo", "APPROVED", HEAD), review("bo", "CHANGES_REQUESTED", HEAD), review("me", "APPROVED", HEAD), review("eve", "APPROVED", HEAD, "NONE"), review("cy", "APPROVED", OLD)];
    expect(approversOnHead(reviews, HEAD, "me")).toEqual(["ana"]);
    expect(approversOnHead(reviews, null, "me")).toEqual([]);
    expect(approversOnHead(reviews, HEAD, null)).toEqual([]);
  });
});

describe("the /ship comment", () => {
  const AFTER = Date.parse("2026-11-04T10:00:00Z");
  const comment = (actor: string, body: string, at = "2026-11-04T11:00:00Z", association: string | null = "COLLABORATOR", extra: Record<string, unknown> = {}) => ({ kind: "comment" as const, actor, isBot: false, association, body, at, ...extra });
  it("a body that is only /ship, trimmed and in any case, is the command; anything else is not", () => {
    for (const body of ["/ship", "  /SHIP\n", "/Ship"]) expect(isShipCommand(body)).toBe(true);
    for (const body of ["/ship it", "please /ship", "/shipping", "`/ship`", "", "/ship\n/ship"]) expect(isShipCommand(body)).toBe(false);
  });
  it("lists the owner, member or collaborator who commented it after the cutoff, oldest first, once each", () => {
    const all = [comment("ana", "/ship"), comment("Bo", "/Ship", "2026-11-04T12:00:00Z", "OWNER"), comment("ana", "/ship", "2026-11-04T13:00:00Z"), comment("cy", "/ship", "2026-11-04T11:00:00Z", "MEMBER")];
    expect(approversByComment(all, AFTER)).toEqual(["ana", "cy", "Bo"]);
  });
  it("does not count a comment from before the cutoff, from a stranger, a bot, a review comment, a deleted user, or an unreadable time", () => {
    const none = [
      comment("ana", "/ship", "2026-11-04T09:00:00Z"),
      comment("ana", "/ship", "2026-11-04T10:00:00Z"),
      comment("eve", "/ship", "2026-11-04T11:00:00Z", "NONE"),
      comment("eve", "/ship", "2026-11-04T11:00:00Z", "CONTRIBUTOR"),
      comment("eve", "/ship", "2026-11-04T11:00:00Z", null),
      comment("bot", "/ship", "2026-11-04T11:00:00Z", "COLLABORATOR", { isBot: true }),
      comment("ana", "/ship", "2026-11-04T11:00:00Z", "COLLABORATOR", { kind: "review_comment" }),
      comment("ana", "/ship", "2026-11-04T11:00:00Z", "COLLABORATOR", { kind: "review" }),
      comment("ana", "/ship", "not a time"),
      comment("ana", "/ship", ""),
      { ...comment("x", "/ship"), actor: null },
      comment("ana", "/ship please"),
    ];
    expect(approversByComment(none, AFTER)).toEqual([]);
  });
  it("counts the token's own login: that is the point, GitHub never lets the PR's author review it", () => {
    expect(approversByComment([comment("me", "/ship")], AFTER)).toEqual(["me"]);
  });
  it("counts nothing when the cutoff is unknown", () => {
    expect(approversByComment([comment("ana", "/ship")], null)).toEqual([]);
  });
});
