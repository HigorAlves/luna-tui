import { describe, expect, it } from "vitest";

import { type AccessSnapshot, accessFlags, accessPage, orgPagePath, quarterOf, repoSlicePage, repoSlicePath } from "./access-review.ts";

const snapshot = (over: Partial<AccessSnapshot> = {}): AccessSnapshot => ({
  org: "acme",
  period: "2026-Q4",
  takenAt: "2026-11-16T12:00:00Z",
  members: [{ login: "ann", role: "admin", active: true }, { login: "bob", role: "member", active: true }],
  outsideCollaborators: [],
  invitations: [],
  repos: [{ slug: "acme/api", admins: [], directCollaborators: [], bypassActors: [], adminsEnforced: true }],
  ...over,
});

const kinds = (s: AccessSnapshot, signed: AccessSnapshot | null = null) => accessFlags(s, signed).flags.map((f) => `${f.kind}:${f.subject}:${f.repo ?? "-"}:${f.change}`);

describe("quarterOf", () => {
  it.each([
    ["2026-01-01T00:00:00Z", "2026-Q1"],
    ["2026-03-31T23:59:59Z", "2026-Q1"],
    ["2026-04-01T00:00:00Z", "2026-Q2"],
    ["2026-11-16T12:00:00Z", "2026-Q4"],
    ["2026-12-31T23:59:59Z", "2026-Q4"],
  ])("%s is %s", (iso, quarter) => {
    expect(quarterOf(new Date(iso))).toBe(quarter);
  });
});

describe("accessFlags", () => {
  it("flags every owner as new on a first review, with stable ids", () => {
    const { flags, removedSinceSigned } = accessFlags(snapshot(), null);
    expect(flags).toEqual([{ id: "org_owner:ann:-", kind: "org_owner", subject: "ann", repo: null, detail: "organization owner", change: "new" }]);
    expect(removedSinceSigned).toEqual([]);
  });

  it("marks what the signed review already had as unchanged and a new admin as new", () => {
    const signed = snapshot({ takenAt: "2026-08-10T00:00:00Z", period: "2026-Q3" });
    const now = snapshot({ members: [...snapshot().members, { login: "cy", role: "admin", active: true }] });
    expect(kinds(now, signed)).toEqual(["org_owner:ann:-:unchanged", "org_owner:cy:-:new"]);
  });

  it("names a collaborator removed since the signed review", () => {
    const signed = snapshot({ outsideCollaborators: [{ login: "ext", repos: [{ repo: "acme/api", permission: "read" }] }], members: [...snapshot().members, { login: "dan", role: "member", active: true }] });
    const { removedSinceSigned } = accessFlags(snapshot(), signed);
    expect(removedSinceSigned).toEqual(["dan", "ext"]);
  });

  it("flags repo admins, direct access, outside collaborators and unenforced admins per repo", () => {
    const s = snapshot({
      outsideCollaborators: [{ login: "ext", repos: [{ repo: "acme/api", permission: "write" }, { repo: "acme/web", permission: "read" }] }],
      repos: [
        {
          slug: "acme/api",
          admins: ["bob"],
          directCollaborators: [{ login: "eve", permission: "write" }, { login: "ext", permission: "write" }],
          bypassActors: [{ ruleset: "main", actorType: "Team", actorId: 7, actorName: "platform", mode: "always" }],
          adminsEnforced: false,
        },
      ],
    });
    const { flags } = accessFlags(s, null);
    expect(flags.map((f) => f.id)).toEqual([
      "org_owner:ann:-",
      "repo_admin:bob:acme/api",
      "bypass_actor:Team:platform:acme/api",
      "admins_not_enforced:acme/api:acme/api",
      "outside_collaborator:ext:-",
      "direct_access:eve:acme/api",
    ]);
    expect(flags.find((f) => f.kind === "outside_collaborator")!.detail).toBe("acme/api (write), acme/web (read)");
    expect(flags.find((f) => f.kind === "direct_access")!.detail).toBe("write");
  });

  it("says unknown when bypass actors or admin enforcement could not be read", () => {
    const s = snapshot({ repos: [{ slug: "acme/api", admins: [], directCollaborators: [], bypassActors: "unknown", adminsEnforced: "unknown" }] });
    const { flags } = accessFlags(s, null);
    expect(flags.filter((f) => f.repo === "acme/api").map((f) => [f.kind, f.detail])).toEqual([
      ["bypass_actor", "could not be read with the token"],
      ["admins_not_enforced", "could not be read with the token"],
    ]);
  });

  it("flags an invitation older than 7 days, not a fresher one", () => {
    const s = snapshot({
      invitations: [
        { login: "old", email: null, role: "direct_member", createdAt: "2026-11-08T11:59:59Z", inviter: "ann" },
        { login: null, email: "new@x.io", role: "admin", createdAt: "2026-11-10T00:00:00Z", inviter: null },
      ],
    });
    const stale = accessFlags(s, null).flags.filter((f) => f.kind === "stale_invitation");
    expect(stale.map((f) => [f.subject, f.detail])).toEqual([["old", "direct_member, invited by ann on 2026-11-08, pending 8 days"]]);
  });

  it("flags a member with no contributions in 90 days, and not one whose activity is unknown", () => {
    const s = snapshot({ members: [{ login: "ann", role: "member", active: false }, { login: "bob", role: "member", active: null }, { login: "cy", role: "member", active: true }] });
    expect(accessFlags(s, null).flags.map((f) => [f.kind, f.subject, f.detail])).toEqual([["dormant", "ann", "no contributions in 90 days"]]);
  });
});

describe("accessPage", () => {
  const s = snapshot({ outsideCollaborators: [{ login: "ext", repos: [{ repo: "acme/api", permission: "read" }] }] });
  const signed = snapshot({ takenAt: "2026-08-10T00:00:00Z", period: "2026-Q3", members: [...snapshot().members, { login: "gone", role: "member", active: true }] });
  const { flags, removedSinceSigned } = accessFlags(s, signed);
  const page = accessPage({ snapshot: s, flags, removedSinceSigned, suggestions: new Map([["outside_collaborator:ext:-", { action: "investigate", reason: "no named owner" }]]), summary: "Two flags.", previous: "2026-Q3" });

  it("opens with the counts and a table per kind, with the person's decision cell", () => {
    expect(page).toContain("# Access review: acme, 2026-Q4");
    expect(page).toContain("- Flags: 2 (1 new)");
    expect(page).toContain("## Organization owners");
    expect(page).toContain("| Subject | Repo | Detail | Change | Suggested action | Decision |");
    expect(page).toContain("| ann | - | organization owner | unchanged |  | _keep / remove_ |");
    expect(page).toContain("| ext | - | acme/api (read) | new | investigate: no named owner | _keep / remove_ |");
    expect(page).not.toContain("## Dormant");
  });

  it("lists what was removed since the last signed review and says how it is signed", () => {
    expect(page).toContain("## Removed since the last signed review");
    expect(page).toContain("- gone");
    expect(page).toContain("signed when the person approves it in Luna");
    expect(page).toContain("records who and when");
  });

  it("marks the reviewer's summary as a suggestion", () => {
    expect(page).toMatch(/Suggested by the reviewer, not the record[\s\S]*Two flags\./);
  });

  it("says when the reviewer did not run", () => {
    const page = accessPage({ snapshot: s, flags, removedSinceSigned: [], suggestions: new Map(), summary: "", reviewerFailed: true, previous: null });
    expect(page).toContain("The reviewer did not run, so no action is suggested.");
  });

  it("says so on a first review", () => {
    const first = accessPage({ snapshot: s, flags: accessFlags(s, null).flags, removedSinceSigned: [], suggestions: new Map(), summary: "", previous: null });
    expect(first).toContain("No review has been signed yet");
    expect(first).not.toContain("Suggested by the reviewer");
  });
});

describe("repoSlicePage", () => {
  it("states one repository's facts and points at the org page", () => {
    const s = snapshot({
      repos: [{ slug: "acme/api", admins: ["bob"], directCollaborators: [{ login: "eve", permission: "write" }], bypassActors: [{ ruleset: "main", actorType: "Team", actorId: 7, actorName: null, mode: "always" }], adminsEnforced: false }],
    });
    const page = repoSlicePage(s, "acme/api", orgPagePath("acme", "2026-Q4"));
    expect(page).toContain("# Access review: acme/api, 2026-Q4");
    expect(page).toContain("Compliance/Access-Reviews/acme-2026-Q4.md");
    expect(page).toContain("- Admins: bob");
    expect(page).toContain("| eve | write |");
    expect(page).toContain("| main | Team 7 | always |");
    expect(page).toContain("- Branch protection applies to admins: no");
    expect(repoSlicePath("2026-Q4")).toBe("Compliance/Access-Reviews/2026-Q4.md");
  });
});
