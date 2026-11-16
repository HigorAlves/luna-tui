// The quarterly access review of a GitHub org: a snapshot of who can do what, the flags a person should look at, and
// what changed since the last review they signed. Pure: no I/O, so every rule is unit tested. The page is computed
// here; a model's suggestions are added to it as marked text and are never the record.
import type { RepoPermission, RulesetBypassActor } from "../application/github.ts";

export interface AccessSnapshot {
  org: string;
  /** `2026-Q4` */
  period: string;
  takenAt: string;
  /** `active`: any contribution in the last 90 days; null when GitHub could not say. */
  members: Array<{ login: string; role: "admin" | "member"; active: boolean | null }>;
  /** Each with the repositories of the review it reaches and its permission there. */
  outsideCollaborators: Array<{ login: string; repos: Array<{ repo: string; permission: RepoPermission }> }>;
  invitations: Array<{ login: string | null; email: string | null; role: string; createdAt: string; inviter: string | null }>;
  repos: Array<{
    slug: string;
    admins: string[];
    directCollaborators: Array<{ login: string; permission: RepoPermission }>;
    bypassActors: RulesetBypassActor[] | "unknown";
    adminsEnforced: boolean | "unknown";
  }>;
}

export type AccessFlagKind = "org_owner" | "repo_admin" | "bypass_actor" | "admins_not_enforced" | "outside_collaborator" | "direct_access" | "stale_invitation" | "dormant";

export interface AccessFlag {
  /** `<kind>:<subject>:<repo or ->`: the same fact has the same id in every review. */
  id: string;
  kind: AccessFlagKind;
  subject: string;
  repo: string | null;
  detail: string;
  change: "new" | "unchanged";
}

const DAY_MS = 86_400_000;
const STALE_INVITATION_DAYS = 7;
const UNREADABLE = "could not be read with the token";

/** `2026-Q4`, by UTC date. */
export function quarterOf(date: Date): string {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

/** Where the org's page lives in the home wiki. */
export const orgPagePath = (org: string, period: string): string => `Compliance/Access-Reviews/${org}-${period}.md`;
/** Where a repository's part lives in that repository's own wiki. */
export const repoSlicePath = (period: string): string => `Compliance/Access-Reviews/${period}.md`;

type Facts = Omit<AccessFlag, "change">;

function factsOf(s: AccessSnapshot): Facts[] {
  const out: Facts[] = [];
  const add = (kind: AccessFlagKind, subject: string, repo: string | null, detail: string) => out.push({ id: `${kind}:${subject}:${repo ?? "-"}`, kind, subject, repo, detail });
  for (const m of s.members) if (m.role === "admin") add("org_owner", m.login, null, "organization owner");
  for (const r of s.repos) for (const login of r.admins) add("repo_admin", login, r.slug, "admin");
  for (const r of s.repos) {
    if (r.bypassActors === "unknown") {
      add("bypass_actor", "unknown", r.slug, UNREADABLE);
      continue;
    }
    // One flag per actor, however many rulesets let it bypass.
    const byActor = new Map<string, string[]>();
    for (const a of r.bypassActors) {
      const key = `${a.actorType}:${a.actorName ?? a.actorId ?? "?"}`;
      byActor.set(key, [...(byActor.get(key) ?? []), `${a.ruleset} (${a.mode})`]);
    }
    for (const [key, rulesets] of byActor) add("bypass_actor", key, r.slug, `may bypass ${rulesets.join(", ")}`);
  }
  for (const r of s.repos) {
    if (r.adminsEnforced === false) add("admins_not_enforced", r.slug, r.slug, "branch protection does not apply to admins");
    else if (r.adminsEnforced === "unknown") add("admins_not_enforced", r.slug, r.slug, UNREADABLE);
  }
  for (const o of s.outsideCollaborators) add("outside_collaborator", o.login, null, o.repos.map((x) => `${x.repo} (${x.permission})`).join(", ") || "no repository of the review");
  const outside = new Set(s.outsideCollaborators.map((o) => o.login));
  for (const r of s.repos) for (const c of r.directCollaborators) if (!outside.has(c.login)) add("direct_access", c.login, r.slug, c.permission);
  const takenAt = Date.parse(s.takenAt);
  for (const i of s.invitations) {
    const age = takenAt - Date.parse(i.createdAt);
    if (age <= STALE_INVITATION_DAYS * DAY_MS) continue;
    const day = i.createdAt.slice(0, 10);
    // An address is never written to a page: an invitation by email is named by its date.
    const subject = i.login ?? `email invitee of ${day}`;
    add("stale_invitation", subject, null, `${i.role}, invited by ${i.inviter ?? "unknown"} on ${day}, pending ${Math.floor(age / DAY_MS)} days`);
  }
  for (const m of s.members) if (m.active === false) add("dormant", m.login, null, "no contributions in 90 days");
  return out;
}

/** The people a snapshot names, for telling what is gone: `login` for an org-level access, `login on owner/name` for a repository's. */
function subjectsOf(s: AccessSnapshot): Set<string> {
  const out = new Set<string>([...s.members.map((m) => m.login), ...s.outsideCollaborators.map((o) => o.login)]);
  for (const r of s.repos) for (const login of [...r.admins, ...r.directCollaborators.map((c) => c.login)]) out.add(`${login} on ${r.slug}`);
  return out;
}

export function accessFlags(snapshot: AccessSnapshot, signed: AccessSnapshot | null): { flags: AccessFlag[]; removedSinceSigned: string[] } {
  const before = signed ? new Set(factsOf(signed).map((f) => f.id)) : new Set<string>();
  const flags = factsOf(snapshot).map((f): AccessFlag => ({ ...f, change: before.has(f.id) ? "unchanged" : "new" }));
  const now = subjectsOf(snapshot);
  const removedSinceSigned = signed ? [...subjectsOf(signed)].filter((x) => !now.has(x)).sort() : [];
  return { flags, removedSinceSigned };
}

const SECTIONS: Array<[AccessFlagKind, string]> = [
  ["org_owner", "Organization owners"],
  ["repo_admin", "Repository admins"],
  ["bypass_actor", "Ruleset bypass actors"],
  ["admins_not_enforced", "Branch protection that does not hold admins"],
  ["outside_collaborator", "Outside collaborators"],
  ["direct_access", "Direct repository access"],
  ["stale_invitation", "Stale invitations"],
  ["dormant", "Dormant members"],
];

const cell = (text: string): string => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

export interface AccessSuggestion {
  action: string;
  reason: string;
}

export function accessPage(input: {
  snapshot: AccessSnapshot;
  flags: AccessFlag[];
  removedSinceSigned: string[];
  /** Keyed by flag id: the reviewer's suggestion for it. */
  suggestions: Map<string, AccessSuggestion>;
  summary: string;
  /** The pack failed: the page says so instead of leaving the column empty without a word. */
  reviewerFailed?: boolean;
  /** The period of the last signed review, or null when none was signed. */
  previous: string | null;
}): string {
  const { snapshot, flags } = input;
  const fresh = flags.filter((f) => f.change === "new").length;
  const lines = [
    `# Access review: ${snapshot.org}, ${snapshot.period}`,
    "",
    `Taken ${snapshot.takenAt}. ${input.previous ? `Compared with the review signed for ${input.previous}.` : "No review has been signed yet, so every flag is new."}`,
    "",
    `- Members: ${snapshot.members.length} (${snapshot.members.filter((m) => m.role === "admin").length} owners)`,
    `- Outside collaborators: ${snapshot.outsideCollaborators.length}`,
    `- Pending invitations: ${snapshot.invitations.length}`,
    `- Flags: ${flags.length} (${fresh} new)`,
    "",
  ];
  if (input.reviewerFailed) lines.push("The reviewer did not run, so no action is suggested.", "");
  if (input.summary) lines.push("## Reviewer's summary", "", "Suggested by the reviewer, not the record.", "", input.summary, "");
  for (const [kind, title] of SECTIONS) {
    const rows = flags.filter((f) => f.kind === kind);
    if (rows.length === 0) continue;
    lines.push(`## ${title}`, "", "| Subject | Repo | Detail | Change | Suggested action | Decision |", "| --- | --- | --- | --- | --- | --- |");
    for (const f of rows) {
      const s = input.suggestions.get(f.id);
      lines.push(`| ${cell(f.subject)} | ${f.repo ?? "-"} | ${cell(f.detail)} | ${f.change} | ${s ? cell(`${s.action}: ${s.reason}`) : ""} | _keep / remove_ |`);
    }
    lines.push("");
  }
  lines.push("## Removed since the last signed review", "");
  lines.push(...(input.removedSinceSigned.length > 0 ? input.removedSinceSigned.map((x) => `- ${x}`) : ["- none"]), "");
  lines.push("Replace the Decision cell of each row with `keep` or `remove` by editing this page. Luna removes no access: the person does, in GitHub.", "");
  lines.push("This review is signed when the person approves it in Luna; the wiki commit records who and when.", "");
  return lines.join("\n");
}

/** One repository's part of the review: facts only, pointing at the org page that carries the decisions. */
export function repoSlicePage(snapshot: AccessSnapshot, slug: string, orgPage: string): string {
  const repo = snapshot.repos.find((r) => r.slug === slug);
  if (!repo) throw new Error(`${slug} is not in the access snapshot of ${snapshot.org}`);
  const lines = [
    `# Access review: ${slug}, ${snapshot.period}`,
    "",
    `Taken ${snapshot.takenAt}. The organization's review, with the decisions, is \`${orgPage}\` in the home wiki.`,
    "",
    `- Admins: ${repo.admins.join(", ") || "none"}`,
    `- Branch protection applies to admins: ${repo.adminsEnforced === "unknown" ? "unknown" : repo.adminsEnforced ? "yes" : "no"}`,
    "",
    "## Direct collaborators",
    "",
  ];
  if (repo.directCollaborators.length === 0) lines.push("None.", "");
  else lines.push("| Login | Permission |", "| --- | --- |", ...repo.directCollaborators.map((c) => `| ${cell(c.login)} | ${c.permission} |`), "");
  lines.push("## Ruleset bypass actors", "");
  if (repo.bypassActors === "unknown") lines.push(`They ${UNREADABLE}.`, "");
  else if (repo.bypassActors.length === 0) lines.push("None.", "");
  else lines.push("| Ruleset | Actor | Mode |", "| --- | --- | --- |", ...repo.bypassActors.map((a) => `| ${cell(a.ruleset)} | ${cell(`${a.actorType} ${a.actorName ?? a.actorId ?? "?"}`)} | ${a.mode} |`), "");
  return lines.join("\n");
}
