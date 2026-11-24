import { describe, expect, it } from "vitest";

import { trustOf, untrustedNote } from "./trust.ts";

describe("untrustedNote", () => {
  it("says the card runs untrusted, with its cache and its runtime", () => {
    expect(untrustedNote({ cacheTrust: "untrusted", runtime: "runsc" })).toBe("This card runs untrusted (its GitHub author is not an owner, member or collaborator): its own cache volume and the runsc container runtime.");
    expect(untrustedNote({ cacheTrust: "trusted" })).toContain("the shared cache volume (cache.split_by_trust is off) and the runc container runtime");
  });
});

const issue = (authorAssociation?: string) => ({ source: { kind: "github" as const, repo: "o/r", number: 1, url: "u", ...(authorAssociation ? { authorAssociation } : {}) } });
const pr = (authorAssociation?: string) => ({ source: { kind: "github_pr" as const, repo: "o/r", number: 1, url: "u", headRef: "h", baseRef: "b", ...(authorAssociation ? { authorAssociation } : {}) } });

describe("trustOf", () => {
  it("trusts a GitHub issue or PR from an owner, member or collaborator", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(trustOf(issue(association))).toBe("trusted");
      expect(trustOf(pr(association))).toBe("trusted");
    }
  });

  it("does not trust a GitHub issue or PR from anyone else", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN"]) {
      expect(trustOf(issue(association))).toBe("untrusted");
      expect(trustOf(pr(association))).toBe("untrusted");
    }
  });

  it("does not trust a GitHub card that has no association recorded", () => {
    expect(trustOf(issue())).toBe("untrusted");
    expect(trustOf(pr())).toBe("untrusted");
  });

  it("trusts every other source, and a card with none", () => {
    expect(trustOf({ source: { kind: "jira", key: "A-1", url: "u", issueType: null } })).toBe("trusted");
    expect(trustOf({ source: { kind: "slack", channel: "c", ts: "1", permalink: "p" } })).toBe("trusted");
    expect(trustOf({ source: { kind: "notch", ref: "L-1", id: "i" } })).toBe("trusted");
    expect(trustOf({ source: null })).toBe("trusted");
    expect(trustOf({})).toBe("trusted");
  });
});
