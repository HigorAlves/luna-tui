import { describe, expect, it } from "vitest";

import { ChangeExceptionKind, ComplianceActInput, ComplianceDraft, ComplianceDraftKind, ComplianceDraftsResponse, ComplianceEditInput, ComplianceTarget } from "./index.ts";

const draft = {
  id: "change_evidence:acme/api:2026-10",
  kind: "change_evidence",
  repo: "acme/api",
  title: "Change management, acme/api, 2026-10",
  period: "2026-10",
  summary: "142 PRs, 3 exceptions",
  text: "# Change management\n",
  status: "waiting",
  hash: "0123456789abcdef",
  targets: [{ kind: "wiki", repo: "acme/api", path: "Compliance/Change-Management/2026-10.md" }],
  history: [],
  createdAt: "2026-11-01T06:00:00.000Z",
  updatedAt: "2026-11-01T06:00:00.000Z",
};

describe("compliance drafts", () => {
  it("parses a change-evidence draft that targets a repo's wiki", () => {
    expect(ComplianceDraft.parse(draft)).toEqual(draft);
    expect(ComplianceDraftsResponse.parse({ drafts: [draft] }).drafts).toHaveLength(1);
  });

  it("keeps the person's edit beside the machine's text, and a failed push's reason", () => {
    const edited = { ...draft, status: "edited", original: "# machine", text: "# mine", error: "push refused", history: [{ at: draft.createdAt, did: "edited", from: "board" }] };
    expect(ComplianceDraft.parse(edited).original).toBe("# machine");
  });

  it("refuses an unknown kind, status or target", () => {
    expect(() => ComplianceDraft.parse({ ...draft, kind: "memo" })).toThrow();
    expect(() => ComplianceDraft.parse({ ...draft, status: "sent" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "email", to: "x" })).toThrow();
  });

  it("refuses a wiki path that climbs out of the wiki or is absolute", () => {
    expect(() => ComplianceTarget.parse({ kind: "wiki", repo: "acme/api", path: "../secrets.md" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "wiki", repo: "acme/api", path: "/etc/passwd" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "wiki", repo: "acme", path: "Home.md" })).toThrow();
  });

  it("names change evidence as the first kind", () => {
    expect(ComplianceDraftKind.options).toContain("change_evidence");
  });

  it("asks for the shown hash on every tap, and text on an edit", () => {
    expect(ComplianceActInput.parse({ hash: "0123456789abcdef" })).toEqual({ hash: "0123456789abcdef" });
    expect(() => ComplianceActInput.parse({})).toThrow();
    expect(() => ComplianceEditInput.parse({ hash: "0123456789abcdef", text: "" })).toThrow();
  });

  it("names the five change-management exceptions", () => {
    expect(ChangeExceptionKind.options).toEqual(["no_independent_approval", "stale_approval", "no_ticket", "checks_red", "bypassed"]);
  });
});
