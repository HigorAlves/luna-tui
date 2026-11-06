// Whether a shipped PR may merge, as a script over GitHub's facts, the Evidence Pack and the
// repo's policy. No model decides this. Pure: the caller fetches the facts (including the
// CODEOWNERS read) and acts on `canAutoMerge`.
import type { Risk } from "@hardness/contracts";

import type { Freeze } from "./policy.ts";
import type { ReviewRequirement } from "./review-rule.ts";
import type { PrFacts } from "./pull-request.ts";

/** A head commit older than this many days is stale. */
export const STALE_DAYS = 14;

const DAY_MS = 86_400_000;

export interface MergeReadinessInput {
  pr: PrFacts;
  /** The commit the Evidence Pack describes. */
  packSha: string | null;
  policy: { autoMerge: "off" | "low" | "medium_when_review_required" | "medium"; freeze: Freeze[] };
  risk: Risk;
  now: Date;
  dependencies: { number: number; merged: boolean; closed: boolean }[];
  /** CODEOWNERS approvals still missing and owners that cannot be resolved; null when the repo has no CODEOWNERS. */
  owners: { missing: { path: string; owners: string[] }[]; unresolved: string[] } | null;
  /** The PR changes a CODEOWNERS file: the rules it would merge under are its own, so a person merges. */
  changesCodeowners?: boolean;
  /** After a fix the loop made: whether an APPROVED review sits on the head itself. Null when the loop made no fix. */
  fixApproval?: { approved: boolean } | null;
  /** How many `Depends on` numbers the body lists; more than MAX_DEPENDENCIES is a blocker (only that many are checked). */
  dependenciesListed?: number;
  /** The repo's `ship.stale_days` (luna.yaml); absent means STALE_DAYS. */
  staleDays?: number;
  /** When this head was re-verified for staleness (checks over the change on a current base): the stale clock counts from the later of the commit and this. */
  reverifiedAt?: string;
  /** Whether the repository requires a review (`reviewRequirement`); absent is read as unknown. */
  review?: ReviewRequirement;
  /** An APPROVED review on the head commit by a collaborator who is not the machine's own account (`approvedOnHead`). */
  approvedOnHead?: boolean;
  /** The login of an owner, member or collaborator whose latest verdict on the PR is "changes requested" (`objectionOnPr`); null when none. Computed by the machine, whatever GitHub's review decision says. */
  objection?: string | null;
  /** An approved `awaiting_ship` ship approval (`requested.gate === "ship_approval"`) and the head it was asked about; null when there is none. */
  shipApproval?: { head: string } | null;
  /** Whether the card is stacked on a parent that has not merged, the branch the PR targets and the repository's default branch (null when unknown). Absent for a card read before the stack existed. */
  stack?: { stacked: boolean; baseRef: string | null; defaultBranch: string | null };
}

/** The items of the checklist, in the order the board shows them. Fixed in code: no model adds or renames one. */
export const CHECKLIST_IDS = ["pack", "draft", "ci", "conflicts", "approvals", "owners", "codeowners_change", "fix_approval", "evidence_head", "freeze", "blocked", "stack", "stale"] as const;
export type ChecklistId = (typeof CHECKLIST_IDS)[number];
export interface ChecklistItem {
  id: ChecklistId;
  ok: boolean;
  detail: string;
}

/** At most this many dependencies are read from a PR body. */
export const MAX_DEPENDENCIES = 10;

export interface MergeReadiness {
  ready: boolean;
  blockers: string[];
  canAutoMerge: boolean;
  reason: string;
  /** One entry per item, in `CHECKLIST_IDS` order; `blockers` are the details of those that are not ok. */
  checklist: ChecklistItem[];
  /** Ready, and a person must still say "safe to release now?" before the machine merges this head. */
  needsShipApproval: boolean;
}

/** Whether both ends of a window are dates. */
export const readableWindow = (window: Freeze): boolean => !Number.isNaN(Date.parse(window.from)) && !Number.isNaN(Date.parse(window.to));

/** The first freeze window that holds `now`; a window with a date that does not parse counts as frozen (fail closed). */
export function inFreeze(freeze: Freeze[], now: Date): Freeze | null {
  for (const window of freeze) {
    if (!readableWindow(window)) return window;
    if (Date.parse(window.from) <= now.getTime() && now.getTime() < Date.parse(window.to)) return window;
  }
  return null;
}

/** The PR numbers a body says it waits for: `Depends on #12`, `Blocked by #3`. */
export function parseDependencies(body: string | null): number[] {
  const found: number[] = [];
  for (const match of (body ?? "").matchAll(/\b(?:depends\s+on|blocked\s+by)\s+#(\d+)/gi)) {
    const n = Number(match[1]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

const sha7 = (sha: string) => sha.slice(0, 7);

export function mergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const { pr, packSha, policy, risk, now, dependencies, owners } = input;
  const blockers: string[] = [];
  const found = new Map<ChecklistId, string[]>();
  const push = (id: ChecklistId, text: string) => {
    blockers.push(text);
    found.set(id, [...(found.get(id) ?? []), text]);
  };
  if (packSha === null) push("pack", "no evidence pack");
  if (input.changesCodeowners) push("codeowners_change", "changes CODEOWNERS: a person merges");
  if (pr.isDraft) push("draft", "draft");
  if (pr.checks.state === "failure") push("ci", "CI is red");
  else if (pr.checks.state === "pending") push("ci", "CI is pending");
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") push("conflicts", "conflicts with the base");
  if (pr.mergeState === "BLOCKED") push("conflicts", "GitHub blocks the merge (BLOCKED)");
  if (pr.reviewDecision === "CHANGES_REQUESTED") push("approvals", "changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") push("approvals", "approval required");
  if (input.objection && pr.reviewDecision !== "CHANGES_REQUESTED") push("approvals", `changes requested by ${input.objection}`);
  for (const m of owners?.missing ?? []) push("owners", `no owner of ${m.path} approved (${m.owners.join(", ")})`);
  for (const o of owners?.unresolved ?? []) push("owners", `owner ${o} cannot be resolved`);
  if (input.fixApproval && !input.fixApproval.approved) push("fix_approval", `the fix at ${sha7(pr.headSha ?? "")} has no approval on it`);
  if (packSha && pr.headSha && packSha !== pr.headSha) push("evidence_head", `the pack shows ${sha7(packSha)}, the head is ${sha7(pr.headSha)}`);
  const frozen = inFreeze(policy.freeze, now);
  if (frozen) push("freeze", readableWindow(frozen) ? `freeze: ${frozen.reason} until ${frozen.to}` : "freeze window has an unreadable date");
  if ((input.dependenciesListed ?? 0) > MAX_DEPENDENCIES) push("blocked", `too many dependencies listed (${input.dependenciesListed})`);
  for (const d of dependencies) if (!d.merged && !d.closed) push("blocked", `blocked by #${d.number}`);
  if (input.stack?.stacked) push("stack", "waits for its parent to merge");
  else if (input.stack && input.stack.defaultBranch && input.stack.baseRef && input.stack.baseRef !== input.stack.defaultBranch) push("stack", `targets ${input.stack.baseRef}, not ${input.stack.defaultBranch}: the machine merges only into the default branch`);
  const staleDays = input.staleDays ?? STALE_DAYS;
  if (pr.headCommittedAt) {
    const committed = Math.max(Date.parse(pr.headCommittedAt), input.reverifiedAt ? Date.parse(input.reverifiedAt) || 0 : 0);
    const days = Math.floor((now.getTime() - committed) / DAY_MS);
    if (!Number.isNaN(committed) && days > staleDays) push("stale", `the head is ${days} days old (limit ${staleDays})`);
  }

  const ready = blockers.length === 0;
  // The machine merges nothing it was not allowed to, and nothing nobody looked at: an approval on the head is always needed (the preview gate and
  // GitHub's reviewDecision alone are not a look at the code), and under the default the repository must itself require a review. High risk also
  // needs a person's ship approval for this head; under the default that answer comes on top of the required review and the approval on the head,
  // never in place of them (only the explicit `low` / `medium` let a board answer stand in for a review).
  const mode = policy.autoMerge;
  const approved = input.approvedOnHead === true;
  const review = input.review ?? { required: null, why: "not read" };
  const head = pr.headSha;
  const shipApproved = input.shipApproval != null && head !== null && input.shipApproval.head === head;
  const coversRisk = mode === "off" || risk === "high" ? false : risk === "medium" ? mode === "medium" || mode === "medium_when_review_required" : true;
  const reviewOk = mode === "medium_when_review_required" ? review.required === true : true;
  // A person's ship approval stands in for the approval on the head only in the two explicit modes; the default always wants the review.
  const looked = approved || (shipApproved && (mode === "low" || mode === "medium"));
  const viaPerson = mode !== "off" && (risk === "high" || (coversRisk && (mode === "low" || mode === "medium")));
  // High risk: the release owner's answer is never a review. The default mode wants a required review and an approval on the head; only the explicit
  // `low` / `medium` let that answer stand in for a review (a repository that requires none, or an approval on the head).
  const highOk =
    risk === "high" &&
    shipApproved &&
    (mode === "medium_when_review_required" ? review.required === true && approved : (mode === "low" || mode === "medium") && (review.required === false || approved));
  const canAutoMerge = ready && (risk === "high" ? highOk : coversRisk && reviewOk && looked);
  const needsShipApproval = ready && viaPerson && !shipApproved && (risk === "high" || !approved);
  const reason = !ready
    ? blockers.join("; ")
    : canAutoMerge
      ? "ready, and the policy lets the machine merge it"
      : mode === "off"
        ? "ready; auto-merge is off, so a person merges it"
        : risk === "high"
          ? shipApproved
            ? mode === "medium_when_review_required" && review.required !== true
              ? "ready; a high-risk PR needs a required review and an approval on the head, which this repository does not give, so a person merges it"
              : `ready; no approval on ${sha7(pr.headSha ?? "")}`
            : "ready; a high-risk PR waits for a person's release approval"
          : !coversRisk
            ? `ready; auto-merge is ${mode} for ${risk} risk, so it waits for a person`
            : mode === "medium_when_review_required" && review.required === false
              ? "ready; this repository requires no review, so a person merges it"
              : mode === "medium_when_review_required" && review.required === null
                ? `ready; whether a review is required could not be read (${review.why}), so a person merges it`
                : `ready; no approval on ${sha7(pr.headSha ?? "")}`;
  const checklist = CHECKLIST_IDS.map((id): ChecklistItem => {
    const why = found.get(id);
    return { id, ok: !why, detail: why ? why.join("; ") : "ok" };
  });
  return { ready, blockers, canAutoMerge, reason, checklist, needsShipApproval };
}
