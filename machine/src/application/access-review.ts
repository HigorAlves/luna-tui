// The quarterly access review of a GitHub org (RFC 0008, wave 4). At the first tick of a quarter, each org that owns a compliance repo
// gets a snapshot of who can do what (facts from GitHub), the flags and what changed since the last review the person signed, and one
// page that waits as a draft. The `access_review` pack only suggests what to do with each flag; a pack that fails never blocks the
// page, and Luna removes no access. Approving the draft writes each repo's part to its wiki and keeps the snapshot as the signed one.
// A cursor under `<stateDir>/compliance/` remembers the last quarter done per org, so a daily tick does no work once it is.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AccessReviewAnswer, type AccessReviewContext, type ComplianceDraft } from "@hardness/contracts";
import { z } from "zod";

import { type AccessFlag, type AccessSnapshot, type AccessSuggestion, accessFlags, accessPage, orgPagePath, quarterOf, repoSlicePage, repoSlicePath } from "../domain/access-review.ts";
import { postable } from "../domain/postable.ts";
import { COMPLIANCE_DIR, type ComplianceDrafts, type TargetWriter, commitMessage, complianceHash } from "./compliance-drafts.ts";
import type { GitHub, RepoPermission } from "./github.ts";
import { WikiError, type Wiki } from "./wiki.ts";

const ACCESS_DIR = "access";
/** A member with no contribution since this many days is dormant. */
const DORMANT_DAYS = 90;
/** The most flags the reviewer is handed: what `AccessReviewContext` allows. */
const FLAG_CAP = 300;

const Permission = z.enum(["admin", "maintain", "write", "triage", "read"]);
const SnapshotSchema: z.ZodType<AccessSnapshot> = z.object({
  org: z.string(),
  period: z.string(),
  takenAt: z.string(),
  members: z.array(z.object({ login: z.string(), role: z.enum(["admin", "member"]), active: z.boolean().nullable() })),
  outsideCollaborators: z.array(z.object({ login: z.string(), repos: z.array(z.object({ repo: z.string(), permission: Permission })) })),
  invitations: z.array(z.object({ login: z.string().nullable(), email: z.string().nullable(), role: z.string(), createdAt: z.string(), inviter: z.string().nullable() })),
  repos: z.array(
    z.object({
      slug: z.string(),
      admins: z.array(z.string()),
      directCollaborators: z.array(z.object({ login: z.string(), permission: Permission })),
      bypassActors: z.union([
        z.literal("unknown"),
        z.array(z.object({ ruleset: z.string(), actorType: z.string(), actorId: z.number().nullable(), actorName: z.string().nullable(), mode: z.string() })),
      ]),
      adminsEnforced: z.union([z.boolean(), z.literal("unknown")]),
    }),
  ),
});

const CursorSchema = z.object({ schema: z.literal(1), done: z.record(z.string(), z.string()) });
type Cursor = z.infer<typeof CursorSchema>;

const accessDir = (stateDir: string, org: string): string => join(stateDir, COMPLIANCE_DIR, ACCESS_DIR, org);
/** The snapshot a page was built from, named by the hash of the machine's text of that page: a rebuild under way writes its own file, never this one. */
const pendingFile = (stateDir: string, org: string, period: string, text: string): string => join(accessDir(stateDir, org), `${period}.${complianceHash(text)}.json`);
/** Where the pending snapshot of a page built before it was keyed by the page lived. */
const legacyPendingFile = (stateDir: string, org: string, period: string): string => join(accessDir(stateDir, org), `${period}.json`);
const signedFile = (stateDir: string, org: string): string => join(accessDir(stateDir, org), "signed.json");

/** A missing or damaged file is no snapshot. */
async function readSnapshot(file: string): Promise<AccessSnapshot | null> {
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type AccessGitHub = Pick<GitHub, "orgMembers" | "outsideCollaborators" | "orgInvitations" | "repoCollaborators" | "rulesetBypassActors" | "adminsEnforced" | "defaultBranch" | "memberActivity">;

export interface AccessReviewDeps {
  github: AccessGitHub;
  drafts: Pick<ComplianceDrafts, "open">;
  /** The one run of the `access_review` pack; its answer is validated here. */
  suggest(context: AccessReviewContext): Promise<unknown>;
  /** The `owner/name` of every compliance repository: an org is reviewed when it owns one. */
  repos(): Promise<string[]>;
  /** Where the org page goes; without it no review is built. */
  managerWikiRepo: string | null;
  stateDir: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export class AccessReview {
  private ticking: Promise<void> | null = null;
  private warnedNoWiki = false;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: AccessReviewDeps) {
    this.log = deps.log ?? ((line) => console.warn(line));
    this.now = deps.now ?? (() => new Date());
  }

  /** The orgs that own a compliance repo, in the order the repos list them. */
  async orgs(): Promise<string[]> {
    return [...new Set((await this.deps.repos()).map((slug) => slug.split("/")[0] ?? "").filter(Boolean))];
  }

  /** The draft page for one org and quarter (`2026-Q4`, UTC), opened or refreshed, with its snapshot kept as pending under the page's hash. */
  async buildQuarter(org: string, period: string = quarterOf(this.now())): Promise<ComplianceDraft> {
    const { managerWikiRepo, stateDir } = this.deps;
    if (!managerWikiRepo) throw new Error("set MACHINE_MANAGER_WIKI_REPO for access reviews");
    const slugs = (await this.deps.repos()).filter((slug) => slug.startsWith(`${org}/`));
    const snapshot = await this.snapshot(org, period, slugs);
    const signed = await readSnapshot(signedFile(stateDir, org));
    const { flags, removedSinceSigned } = accessFlags(snapshot, signed);
    const { suggestions, summary, failed } = await this.suggest(org, period, flags, removedSinceSigned);
    const text = accessPage({ snapshot, flags, removedSinceSigned, suggestions, summary, reviewerFailed: failed, previous: signed?.period ?? null });
    const fresh = flags.filter((f) => f.change === "new").length;
    await writeAtomic(pendingFile(stateDir, org, period, text), JSON.stringify(snapshot));
    return this.deps.drafts.open({
      id: `access_review:${org}:${period}`,
      kind: "access_review",
      repo: managerWikiRepo,
      title: `Access review, ${org}, ${period}`,
      period,
      summary: `${flags.length} flags, ${fresh} new${failed ? "; the reviewer failed" : ""}`,
      text,
      targets: [
        { kind: "wiki", repo: managerWikiRepo, path: orgPagePath(org, period) },
        { kind: "access_slices", org, period },
      ],
    });
  }

  /** One pass: each org not done with this quarter. A pass already running is joined, not doubled. */
  tick(now: Date = this.now()): Promise<void> {
    this.ticking ??= this.pass(quarterOf(now)).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(period: string): Promise<void> {
    if (!this.deps.managerWikiRepo) {
      if (!this.warnedNoWiki) this.log("compliance access review: set MACHINE_MANAGER_WIKI_REPO for access reviews");
      this.warnedNoWiki = true;
      return;
    }
    const cursor = await this.loadCursor();
    for (const org of await this.orgs()) {
      if (cursor.done[org] === period) continue;
      try {
        await this.buildQuarter(org, period);
      } catch (error) {
        this.log(`compliance access review: ${org} ${period}: ${messageOf(error)}`);
        continue;
      }
      cursor.done[org] = period;
      await this.saveCursor(cursor);
    }
  }

  private async snapshot(org: string, period: string, slugs: string[]): Promise<AccessSnapshot> {
    const { github } = this.deps;
    const takenAt = this.now();
    const members = await github.orgMembers(org);
    const owners = new Set(members.filter((m) => m.role === "admin").map((m) => m.login));
    // Activity is a nicety: when GitHub cannot say, it is unknown and nothing is flagged dormant.
    const activity = await github.memberActivity(org, members.map((m) => m.login), new Date(takenAt.getTime() - DORMANT_DAYS * 86_400_000).toISOString()).catch((error: unknown) => {
      this.log(`compliance access review: ${org} ${period}: member activity unknown: ${messageOf(error)}`);
      return null;
    });
    const outside = (await github.outsideCollaborators(org)).map((o) => o.login);
    const invitations = await github.orgInvitations(org);
    const reached = new Map<string, Array<{ repo: string; permission: RepoPermission }>>(outside.map((login) => [login, []]));
    const repos: AccessSnapshot["repos"] = [];
    for (const slug of slugs) {
      const collaborators = await github.repoCollaborators(slug);
      for (const c of collaborators) reached.get(c.login)?.push({ repo: slug, permission: c.permission });
      repos.push({
        slug,
        // An org owner is an admin of every repo and is flagged once, as an owner.
        admins: collaborators.filter((c) => c.permission === "admin" && !owners.has(c.login)).map((c) => c.login),
        directCollaborators: collaborators.filter((c) => c.direct && c.permission !== "admin").map((c) => ({ login: c.login, permission: c.permission })),
        bypassActors: await github.rulesetBypassActors(slug),
        adminsEnforced: await github.adminsEnforced(slug, (await github.defaultBranch(slug)) ?? "main"),
      });
    }
    return {
      org,
      period,
      takenAt: takenAt.toISOString(),
      members: members.map((m) => ({ login: m.login, role: m.role, active: activity ? (activity.get(m.login) ?? false) : null })),
      outsideCollaborators: outside.map((login) => ({ login, repos: reached.get(login) ?? [] })),
      invitations,
      repos,
    };
  }

  /** The reviewer's suggestion per flag id; empty, with `failed`, when the pack failed or its answer was not valid. */
  private async suggest(org: string, period: string, flags: AccessFlag[], removedSinceSigned: string[]): Promise<{ suggestions: Map<string, AccessSuggestion>; summary: string; failed: boolean }> {
    try {
      // The new flags first: when there are more than the pack can read, they are the ones that matter.
      const given = [...flags.filter((f) => f.change === "new"), ...flags.filter((f) => f.change === "unchanged")].slice(0, FLAG_CAP);
      const context: AccessReviewContext = {
        org,
        period,
        flags: given.map((f) => ({ id: f.id, kind: f.kind, subject: f.subject, repo: f.repo, detail: f.detail, change: f.change })),
        removedSinceSigned: removedSinceSigned.slice(0, 500),
      };
      const answer = AccessReviewAnswer.parse(await this.deps.suggest(context));
      const known = new Set(given.map((f) => f.id));
      const suggestions = new Map<string, AccessSuggestion>();
      for (const r of answer.recommendations) {
        const reason = postable(r.reason, 300);
        if (known.has(r.flagId) && reason) suggestions.set(r.flagId, { action: r.action, reason });
      }
      return { suggestions, summary: postable(answer.summary, 600), failed: false };
    } catch (error) {
      this.log(`compliance access review: ${org} ${period}: the reviewer failed: ${messageOf(error)}`);
      return { suggestions: new Map(), summary: "", failed: true };
    }
  }

  private cursorFile(): string {
    return join(this.deps.stateDir, COMPLIANCE_DIR, "access-cursor.json");
  }

  /** A damaged or missing file is an empty cursor: every org's quarter is built again. */
  private async loadCursor(): Promise<Cursor> {
    try {
      const parsed = CursorSchema.safeParse(JSON.parse(await readFile(this.cursorFile(), "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // No file, or not JSON.
    }
    return { schema: 1, done: {} };
  }

  private async saveCursor(cursor: Cursor): Promise<void> {
    await writeAtomic(this.cursorFile(), JSON.stringify(cursor));
  }
}

/** The `access_slices` writer of an approved review: each repo's part goes to that repo's own wiki, then the pending snapshot becomes the signed one
 *  the next review compares with. A repo whose wiki does not exist yet is skipped and logged, so it never blocks signing; any other wiki error throws
 *  and signs nothing. Safe to repeat: a wiki write of unchanged pages makes no commit, and the copy replaces the file whole. */
export function accessSlicesWriter(deps: { wiki: Wiki; stateDir: string; log?: (line: string) => void }): TargetWriter<"access_slices"> {
  const log = deps.log ?? ((line) => console.warn(line));
  return async (draft, { org, period }) => {
    // The snapshot of the page the person approved: the machine's own text, which an edit leaves in `original`.
    const page = draft.original ?? draft.text;
    const snapshot = (page === undefined ? null : await readSnapshot(pendingFile(deps.stateDir, org, period, page))) ?? (await readSnapshot(legacyPendingFile(deps.stateDir, org, period)));
    if (!snapshot) throw new Error(`no access snapshot for ${org} ${period}: build the review again`);
    for (const repo of snapshot.repos) {
      try {
        await deps.wiki.writePages(repo.slug, [{ path: repoSlicePath(period), text: repoSlicePage(snapshot, repo.slug, orgPagePath(org, period)) }], commitMessage(draft));
      } catch (error) {
        if (error instanceof WikiError && /does not exist yet/.test(error.message)) {
          log(`compliance access review: ${repo.slug} ${period}: skipped, ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    await writeAtomic(signedFile(deps.stateDir, org), JSON.stringify(snapshot));
  };
}
