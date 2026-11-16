import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccessReviewContext } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessSnapshot } from "../domain/access-review.ts";
import { AccessReview } from "./access-review.ts";
import { ComplianceDrafts } from "./compliance-drafts.ts";
import { GitHubError, type GitHub } from "./github.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "access-review-"));
});

interface Fakes {
  repos?: string[];
  managerWikiRepo?: string | null;
  suggest?: (context: AccessReviewContext) => Promise<unknown>;
  members?: Record<string, Array<{ login: string; role: "admin" | "member" }> | Error>;
  activity?: Map<string, boolean> | Error;
  now?: string;
}
function build(fakes: Fakes = {}) {
  const github = {
    orgMembers: vi.fn(async (org: string) => {
      const found = fakes.members?.[org] ?? [{ login: "ann", role: "admin" as const }, { login: "bob", role: "member" as const }];
      if (found instanceof Error) throw found;
      return found;
    }),
    outsideCollaborators: vi.fn(async () => [{ login: "ext" }]),
    orgInvitations: vi.fn(async () => []),
    repoCollaborators: vi.fn(async () => [
      { login: "ann", permission: "admin" as const, direct: false },
      { login: "bob", permission: "admin" as const, direct: true },
      { login: "eve", permission: "write" as const, direct: true },
      { login: "ext", permission: "read" as const, direct: true },
    ]),
    rulesetBypassActors: vi.fn(async () => "unknown" as const),
    adminsEnforced: vi.fn(async () => true),
    defaultBranch: vi.fn(async () => "trunk"),
    memberActivity: vi.fn(async (_org: string, logins: string[]) => {
      if (fakes.activity instanceof Error) throw fakes.activity;
      return fakes.activity ?? new Map(logins.map((l) => [l, l !== "bob"]));
    }),
  };
  const drafts = new ComplianceDrafts({ stateDir });
  const log = vi.fn();
  const suggest = vi.fn(fakes.suggest ?? (async () => ({ recommendations: [], summary: "" })));
  const job = new AccessReview({
    github: github as unknown as Pick<GitHub, keyof typeof github>,
    drafts,
    suggest,
    repos: async () => fakes.repos ?? ["acme/api", "acme/web", "other/tool"],
    managerWikiRepo: fakes.managerWikiRepo === undefined ? "acme/wiki" : fakes.managerWikiRepo,
    stateDir,
    log,
    now: () => new Date(fakes.now ?? "2026-11-16T12:00:00Z"),
  });
  return { job, github, drafts, log, suggest };
}

const pendingFile = (org: string, period: string) => join(stateDir, "compliance", "access", org, `${period}.json`);
const signedFile = (org: string) => join(stateDir, "compliance", "access", org, "signed.json");

describe("buildQuarter", () => {
  it("takes the org's snapshot of its compliance repos, keeps it as pending and opens the draft with both targets", async () => {
    const { job, github, drafts } = build();
    const draft = await job.buildQuarter("acme", "2026-Q4");
    expect(draft).toMatchObject({
      id: "access_review:acme:2026-Q4",
      kind: "access_review",
      repo: "acme/wiki",
      title: "Access review, acme, 2026-Q4",
      period: "2026-Q4",
      status: "waiting",
      targets: [
        { kind: "wiki", repo: "acme/wiki", path: "Compliance/Access-Reviews/acme-2026-Q4.md" },
        { kind: "access_slices", org: "acme", period: "2026-Q4" },
      ],
    });
    expect(draft.summary).toMatch(/^\d+ flags, \d+ new$/);
    expect((await drafts.get("access_review:acme:2026-Q4"))!.text).toBe(draft.text);
    const snapshot = JSON.parse(readFileSync(pendingFile("acme", "2026-Q4"), "utf8")) as AccessSnapshot;
    expect(snapshot).toMatchObject({ org: "acme", period: "2026-Q4", takenAt: "2026-11-16T12:00:00.000Z" });
    expect(snapshot.members).toEqual([
      { login: "ann", role: "admin", active: true },
      { login: "bob", role: "member", active: false },
    ]);
    expect(snapshot.outsideCollaborators).toEqual([{ login: "ext", repos: [{ repo: "acme/api", permission: "read" }, { repo: "acme/web", permission: "read" }] }]);
    // Only this org's repos; an org owner is not a repo admin; a direct admin is listed as an admin, not as direct access.
    expect(snapshot.repos.map((r) => r.slug)).toEqual(["acme/api", "acme/web"]);
    expect(snapshot.repos[0]).toEqual({ slug: "acme/api", admins: ["bob"], directCollaborators: [{ login: "eve", permission: "write" }, { login: "ext", permission: "read" }], bypassActors: "unknown", adminsEnforced: true });
    expect(github.adminsEnforced).toHaveBeenCalledWith("acme/api", "trunk");
    expect(github.memberActivity).toHaveBeenCalledWith("acme", ["ann", "bob"], "2026-08-18T12:00:00.000Z");
  });

  it("compares with the last signed snapshot and hands the pack the flags, the new ones first", async () => {
    const signed: AccessSnapshot = {
      org: "acme",
      period: "2026-Q3",
      takenAt: "2026-08-10T00:00:00Z",
      members: [{ login: "ann", role: "admin", active: true }, { login: "gone", role: "member", active: true }],
      outsideCollaborators: [],
      invitations: [],
      repos: [],
    };
    mkdirSync(join(stateDir, "compliance", "access", "acme"), { recursive: true });
    writeFileSync(signedFile("acme"), JSON.stringify(signed));
    const { job, suggest } = build();
    const draft = await job.buildQuarter("acme", "2026-Q4");
    const context = suggest.mock.calls[0]![0];
    expect(context).toMatchObject({ org: "acme", period: "2026-Q4", removedSinceSigned: ["gone"] });
    expect(context.flags[0]!.change).toBe("new");
    expect(context.flags.find((f) => f.id === "org_owner:ann:-")!.change).toBe("unchanged");
    expect(draft.text).toContain("Compared with the review signed for 2026-Q3.");
    expect(draft.text).toContain("- gone");
  });

  it("puts the pack's suggestions beside their flags and drops one for a flag it was not given", async () => {
    const { job } = build({
      suggest: async () => ({
        recommendations: [
          { flagId: "outside_collaborator:ext:-", action: "remove", reason: "No owner named." },
          { flagId: "made_up:x:-", action: "keep", reason: "Invented." },
        ],
        summary: "One outside collaborator.",
      }),
    });
    const { text } = await job.buildQuarter("acme", "2026-Q4");
    expect(text).toContain("| remove: No owner named. |");
    expect(text).not.toContain("Invented");
    expect(text).toContain("One outside collaborator.");
  });

  it("opens the page with empty suggestions, and says so, when the pack fails or answers badly", async () => {
    for (const suggest of [async () => Promise.reject(new Error("no model")), async () => ({ nope: true })]) {
      const { job, log } = build({ suggest });
      const draft = await job.buildQuarter("acme", "2026-Q4");
      expect(draft.text).toContain("The reviewer did not run, so no action is suggested.");
      expect(draft.summary).toMatch(/; the reviewer failed$/);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("the reviewer failed"));
    }
  });

  it("reads activity as unknown, never failing the review, when GitHub cannot say", async () => {
    const { job } = build({ activity: new GitHubError("rate limited") });
    await job.buildQuarter("acme", "2026-Q4");
    const snapshot = JSON.parse(readFileSync(pendingFile("acme", "2026-Q4"), "utf8")) as AccessSnapshot;
    expect(snapshot.members.map((m) => m.active)).toEqual([null, null]);
  });
});

describe("tick", () => {
  it("does nothing, and says why once, without MACHINE_MANAGER_WIKI_REPO", async () => {
    const { job, github, log } = build({ managerWikiRepo: null });
    await job.tick();
    await job.tick();
    expect(github.orgMembers).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([line]) => String(line).includes("set MACHINE_MANAGER_WIKI_REPO for access reviews"))).toHaveLength(1);
  });

  it("reviews each distinct owner of the compliance repos once a quarter", async () => {
    const { job, github, drafts } = build();
    await job.tick();
    expect(github.orgMembers.mock.calls.map((c) => c[0])).toEqual(["acme", "other"]);
    expect((await drafts.list()).map((d) => d.id).sort()).toEqual(["access_review:acme:2026-Q4", "access_review:other:2026-Q4"]);
    await job.tick(new Date("2026-12-31T00:00:00Z"));
    expect(github.orgMembers).toHaveBeenCalledTimes(2);
    await job.tick(new Date("2027-01-02T00:00:00Z"));
    expect(github.orgMembers).toHaveBeenCalledTimes(4);
  });

  it("keeps going when one org fails, and tries the failed one again at the next tick", async () => {
    const { job, github, drafts, log } = build({ members: { acme: new GitHubError("bad credentials") } });
    await job.tick();
    expect((await drafts.list()).map((d) => d.id)).toEqual(["access_review:other:2026-Q4"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("acme 2026-Q4: bad credentials"));
    await job.tick();
    expect(github.orgMembers.mock.calls.map((c) => c[0])).toEqual(["acme", "other", "acme"]);
  });

  it("joins a pass already running instead of starting a second", async () => {
    const { job, github } = build();
    await Promise.all([job.tick(), job.tick()]);
    expect(github.orgMembers).toHaveBeenCalledTimes(2);
  });

  it("treats a damaged cursor as empty", async () => {
    mkdirSync(join(stateDir, "compliance"), { recursive: true });
    writeFileSync(join(stateDir, "compliance", "access-cursor.json"), "{not json");
    const { job, github } = build();
    await job.tick();
    expect(github.orgMembers).toHaveBeenCalledTimes(2);
  });
});
