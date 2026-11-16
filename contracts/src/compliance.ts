// The manager's drafts (RFC 0008): every page, post, comment, issue and release body an agent
// writes for the person waits here until the person approves, edits or ignores it in the board's
// Compliance view. The machine computes the hash of the shown text; a tap must name it, so a
// draft that changed under the person never posts.
import { z } from "zod";

/** What a draft is. Each wave adds its own kind. */
export const ComplianceDraftKind = z.enum(["change_evidence"]);
export type ComplianceDraftKind = z.infer<typeof ComplianceDraftKind>;

/** `waiting` for a tap; `edited` is still waiting, with the person's text; `ignored` is kept and never posted; `posting` is claimed by an approve. */
export const ComplianceDraftStatus = z.enum(["waiting", "edited", "ignored", "posting", "posted"]);
export type ComplianceDraftStatus = z.infer<typeof ComplianceDraftStatus>;

const Slug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name");
/** A page path inside a wiki: relative, no `..` segment, ends in `.md`. */
const WikiPath = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\/-]*\.md$/, "a relative .md path")
  .refine((path) => !path.split("/").includes(".."), "no .. segment");

/** Where an approved draft goes. Each wave adds its own target. */
export const ComplianceTarget = z.discriminatedUnion("kind", [z.object({ kind: z.literal("wiki"), repo: Slug, path: WikiPath })]);
export type ComplianceTarget = z.infer<typeof ComplianceTarget>;

export const ComplianceDraft = z.object({
  /** Stable per kind, repo and period, so a re-run updates the draft instead of opening a second. */
  id: z.string().min(1),
  kind: ComplianceDraftKind,
  repo: Slug,
  title: z.string().min(1),
  /** The period a periodic draft covers (`2026-10`, `2026-Q4`, `2026-W46`); null for one that has none. */
  period: z.string().nullable(),
  /** One line for the list. */
  summary: z.string(),
  /** The markdown the person reads and the targets receive. */
  text: z.string(),
  /** The machine's own text, kept beside an edit. */
  original: z.string().optional(),
  status: ComplianceDraftStatus,
  /** The first 16 hex digits of the sha256 of `text`: what a tap must name. */
  hash: z.string().regex(/^[0-9a-f]{16}$/),
  targets: z.array(ComplianceTarget).min(1),
  history: z.array(z.object({ at: z.string(), did: z.enum(["edited", "ignored", "posted", "failed"]), from: z.string() })),
  /** Why the last approve did not post, in the target's own words. */
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ComplianceDraft = z.infer<typeof ComplianceDraft>;

export const ComplianceDraftsResponse = z.object({ drafts: z.array(ComplianceDraft) });
export type ComplianceDraftsResponse = z.infer<typeof ComplianceDraftsResponse>;

/** Why a merged PR fails change management (SOC2 CC8.1): no approval by a person other than its author;
 *  approvals only on an earlier commit than the one merged; no Jira key or closing issue; a check that
 *  failed at the merged commit; a ruleset bypassed at the merge. */
export const ChangeExceptionKind = z.enum(["no_independent_approval", "stale_approval", "no_ticket", "checks_red", "bypassed"]);
export type ChangeExceptionKind = z.infer<typeof ChangeExceptionKind>;

/** The body of an approve or an ignore tap. */
export const ComplianceActInput = z.object({ hash: z.string().regex(/^[0-9a-f]{16}$/) });
export type ComplianceActInput = z.infer<typeof ComplianceActInput>;

/** The body of an edit tap. */
export const ComplianceEditInput = ComplianceActInput.extend({ text: z.string().min(1) });
export type ComplianceEditInput = z.infer<typeof ComplianceEditInput>;
