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
}

export interface MergeReadiness {
  ready: boolean;
  blockers: string[];
  canAutoMerge: boolean;
  reason: string;
}

/** The first freeze window that holds `now`; a window with a date that does not parse is ignored. */
export function inFreeze(freeze: Freeze[], now: Date): Freeze | null {
  for (const window of freeze) {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    if (from <= now.getTime() && now.getTime() < to) return window;
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
  if (pr.isDraft) blockers.push("draft");
  if (pr.checks.state === "failure") blockers.push("CI is red");
  else if (pr.checks.state === "pending") blockers.push("CI is pending");
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") blockers.push("conflicts with the base");
  if (pr.mergeState === "BLOCKED") blockers.push("GitHub blocks the merge (BLOCKED)");
  if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") blockers.push("approval required");
  for (const m of owners?.missing ?? []) blockers.push(`no owner of ${m.path} approved (${m.owners.join(", ")})`);
  for (const o of owners?.unresolved ?? []) blockers.push(`owner ${o} cannot be resolved`);
  if (packSha && pr.headSha && packSha !== pr.headSha) blockers.push(`the pack shows ${sha7(packSha)}, the head is ${sha7(pr.headSha)}`);
  const frozen = inFreeze(policy.freeze, now);
  if (frozen) blockers.push(`freeze: ${frozen.reason} until ${frozen.to}`);
  for (const d of dependencies) if (!d.merged && !d.closed) blockers.push(`blocked by #${d.number}`);
  if (pr.headCommittedAt) {
    const committed = Date.parse(pr.headCommittedAt);
    const days = Math.floor((now.getTime() - committed) / DAY_MS);
    if (!Number.isNaN(committed) && days > STALE_DAYS) blockers.push(`the head is ${days} days old (limit ${STALE_DAYS})`);
  }

  const ready = blockers.length === 0;
  // `off` never merges, whatever the risk; high risk needs the ship approver's attestation on top of a policy that is on.
  const allowed = policy.autoMerge === "off" ? false : risk === "high" ? shipApprover !== null : risk === "medium" ? policy.autoMerge === "medium" : true;
  const canAutoMerge = ready && allowed;
  const reason = !ready
    ? blockers.join("; ")
    : canAutoMerge
      ? "ready, and the policy lets the machine merge it"
      : risk === "high" && policy.autoMerge !== "off" && shipApprover === null
        ? "ready; a high-risk PR waits for a ship approver"
        : `ready; auto-merge is ${policy.autoMerge} for ${risk} risk, so it waits for a person`;
  return { ready, blockers, canAutoMerge, reason };
}
