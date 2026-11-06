// Whether a shipped PR may merge, as a script over GitHub's facts, the Evidence Pack and the
// repo's policy. No model decides this. Pure: the caller fetches the facts (including the
// CODEOWNERS read) and acts on `canAutoMerge`.
import type { Risk } from "@hardness/contracts";

import type { Freeze } from "./policy.ts";
import type { PrFacts } from "./pull-request.ts";

/** A head commit older than this many days is stale. */
export const STALE_DAYS = 14;

const DAY_MS = 86_400_000;

export interface MergeReadinessInput {
  pr: PrFacts;
  /** The commit the Evidence Pack describes. */
  packSha: string | null;
  policy: { autoMerge: "off" | "low" | "medium"; freeze: Freeze[] };
  risk: Risk;
  /** The attested ship approver of a high-risk pack, when there is one. */
  shipApprover: string | null;
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
  /** A person looked: an approved `awaiting_ship` gate is on record for the card. An approving review on the PR counts too. */
  humanLook?: boolean;
}

/** At most this many dependencies are read from a PR body. */
export const MAX_DEPENDENCIES = 10;

export interface MergeReadiness {
  ready: boolean;
  blockers: string[];
  canAutoMerge: boolean;
  reason: string;
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
  const { pr, packSha, policy, risk, shipApprover, now, dependencies, owners } = input;
  const blockers: string[] = [];
  if (packSha === null) blockers.push("no evidence pack");
  if (input.changesCodeowners) blockers.push("changes CODEOWNERS: a person merges");
  if (pr.isDraft) blockers.push("draft");
  if (pr.checks.state === "failure") blockers.push("CI is red");
  else if (pr.checks.state === "pending") blockers.push("CI is pending");
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") blockers.push("conflicts with the base");
  if (pr.mergeState === "BLOCKED") blockers.push("GitHub blocks the merge (BLOCKED)");
  if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") blockers.push("approval required");
  for (const m of owners?.missing ?? []) blockers.push(`no owner of ${m.path} approved (${m.owners.join(", ")})`);
  for (const o of owners?.unresolved ?? []) blockers.push(`owner ${o} cannot be resolved`);
  if (input.fixApproval && !input.fixApproval.approved) blockers.push(`the fix at ${sha7(pr.headSha ?? "")} has no approval on it`);
  if (packSha && pr.headSha && packSha !== pr.headSha) blockers.push(`the pack shows ${sha7(packSha)}, the head is ${sha7(pr.headSha)}`);
  const frozen = inFreeze(policy.freeze, now);
  if (frozen) blockers.push(readableWindow(frozen) ? `freeze: ${frozen.reason} until ${frozen.to}` : "freeze window has an unreadable date");
  if ((input.dependenciesListed ?? 0) > MAX_DEPENDENCIES) blockers.push(`too many dependencies listed (${input.dependenciesListed})`);
  for (const d of dependencies) if (!d.merged && !d.closed) blockers.push(`blocked by #${d.number}`);
  const staleDays = input.staleDays ?? STALE_DAYS;
  if (pr.headCommittedAt) {
    const committed = Date.parse(pr.headCommittedAt);
    const days = Math.floor((now.getTime() - committed) / DAY_MS);
    if (!Number.isNaN(committed) && days > staleDays) blockers.push(`the head is ${days} days old (limit ${staleDays})`);
  }

  const ready = blockers.length === 0;
  // `off` never merges, whatever the risk; high risk needs the ship approver's attestation on top of a policy that is on.
  const allowed = policy.autoMerge === "off" ? false : risk === "high" ? shipApprover !== null : risk === "medium" ? policy.autoMerge === "medium" : true;
  // Without the preview gate nobody is guaranteed to have seen the PR: the machine merges only one a person approved or an approving review covers (until D4, wave 13).
  const humanLook = input.humanLook === true || pr.reviewDecision === "APPROVED";
  const canAutoMerge = ready && allowed && humanLook;
  const reason = !ready
    ? blockers.join("; ")
    : canAutoMerge
      ? "ready, and the policy lets the machine merge it"
      : allowed && !humanLook
        ? "ready; an approving review is needed before the machine merges a PR no person has looked at"
        : risk === "high" && policy.autoMerge !== "off" && shipApprover === null
        ? "ready; a high-risk PR waits for a ship approver"
        : `ready; auto-merge is ${policy.autoMerge} for ${risk} risk, so it waits for a person`;
  return { ready, blockers, canAutoMerge, reason };
}
