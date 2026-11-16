// Change-management evidence: what a month's merged PRs show about how each change was approved, tracked, tested and
// merged, computed from GitHub's facts and written as one page. Pure: no I/O, so every rule is unit tested.
import type { ChangeExceptionKind } from "@hardness/contracts";

import type { Check, MergedPr, RuleBypass } from "../application/github.ts";
import type { VulnRow } from "../application/vulns.ts";
import { FAILED_CHECK_STATES, PENDING_CHECK_STATES } from "./check-states.ts";

/** One merged PR as an auditor reads it: the facts, and the exceptions they add up to. */
export interface ChangeRecord {
  number: number;
  title: string;
  url: string;
  author: string | null;
  mergedBy: string | null;
  mergedAt: string;
  /** Distinct reviewers who approved and are not the author. */
  approvedBy: string[];
  /** The Jira key, else the first issue the PR closes (`#12`), else null. */
  ticket: string | null;
  /** `pending`: a check had not ended when the PR merged; it is not green. */
  checks: "green" | "red" | "pending" | "none";
  bypass: "yes" | "no" | "unknown";
  exceptions: ChangeExceptionKind[];
}

export function changeRecord(pr: MergedPr, input: { checks: Check[]; bypasses: RuleBypass[] | "unknown"; jiraKey: string | null }): ChangeRecord {
  // Per reviewer, the latest review that approves or objects: a comment or a pending review changes neither. Only a standing approval counts.
  const stands = new Map<string, MergedPr["reviews"][number]>();
  const decisive = pr.reviews.filter((r) => r.author !== null && r.author !== pr.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED"));
  const byTime = [...decisive].sort((a, b) => (a.submittedAt !== null && b.submittedAt !== null ? Date.parse(a.submittedAt) - Date.parse(b.submittedAt) : 0));
  for (const r of byTime) stands.set(r.author as string, r);
  const approvals = [...stands.values()].filter((r) => r.state === "APPROVED");
  const approvedBy = [...new Set(approvals.map((r) => r.author as string))];
  const ticket = input.jiraKey ?? (pr.closingIssues[0] ? `#${pr.closingIssues[0].number}` : null);
  const stateOf = (c: Check): string => String(c.state).toUpperCase();
  const checks = input.checks.some((c) => FAILED_CHECK_STATES.has(stateOf(c))) ? "red" : input.checks.some((c) => PENDING_CHECK_STATES.has(stateOf(c))) ? "pending" : input.checks.length === 0 ? "none" : "green";
  const bypass = input.bypasses === "unknown" ? "unknown" : input.bypasses.some((b) => b.ref === `refs/heads/${pr.baseRef}` && b.afterSha !== null && b.afterSha === pr.mergeSha) ? "yes" : "no";

  const exceptions: ChangeExceptionKind[] = [];
  if (approvedBy.length === 0) exceptions.push("no_independent_approval");
  else if (pr.headSha !== null && !approvals.some((r) => r.commitId === pr.headSha)) exceptions.push("stale_approval");
  if (ticket === null) exceptions.push("no_ticket");
  if (checks === "red") exceptions.push("checks_red");
  else if (checks === "pending" || checks === "none") exceptions.push("checks_not_green");
  if (bypass === "yes") exceptions.push("bypassed");
  return { number: pr.number, title: pr.title, url: pr.url, author: pr.author, mergedBy: pr.mergedBy, mergedAt: pr.mergedAt, approvedBy, ticket, checks, bypass, exceptions };
}

/** Where the month's page lives in the wiki. */
export const evidencePath = (period: string): string => `Compliance/Change-Management/${period}.md`;

const cell = (text: string): string => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/**
 * Open alerts with their deadlines, as of when the page was generated. The state drops an alert once it closes, so how many
 * closed within or after their deadline is not recorded and the section says open and overdue only.
 */
function vulnerabilitySection(vulns: VulnRow[]): string[] {
  const overdue = vulns.filter((v) => v.overdue).length;
  const lines = ["## Vulnerability remediation", "", "Controls evidenced: SOC2 CC7.1 (detection and remediation of vulnerabilities).", "", `- Open alerts: ${vulns.length}, ${overdue} overdue`, "- Alerts that closed are not kept, so only the open and overdue ones are shown.", ""];
  if (vulns.length > 0) {
    lines.push("| Alert | Severity | Lane | Deadline | Status |", "| --- | --- | --- | --- | --- |");
    for (const v of [...vulns].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.deadline.localeCompare(b.deadline))) lines.push(`| ${cell(v.key)} | ${v.severity} | ${v.lane} | ${v.deadline} | ${v.overdue ? "OVERDUE" : "open"} |`);
    lines.push("");
  }
  return lines;
}

export function evidencePage(input: { repo: string; period: string; records: ChangeRecord[]; bypassUnknown: boolean; explanations: Map<string, string>; generatedAt: string; vulns?: VulnRow[] }): string {
  const { records } = input;
  const flagged = records.filter((r) => r.exceptions.length > 0);
  const lines = [
    `# Change management evidence: ${input.repo}, ${input.period}`,
    "",
    `Generated ${input.generatedAt}.`,
    "",
    "Controls evidenced: SOC2 CC8.1 (change management); HIPAA 164.308(a)(1)(ii)(D) (information system activity review).",
    "",
    `- PRs merged: ${records.length}`,
    `- PRs with exceptions: ${flagged.length}`,
    "",
  ];
  if (records.length === 0) {
    lines.push("No PRs were merged in this period.", "");
  } else {
    lines.push("| PR | Author | Merged by | Approved by | Ticket | Checks | Bypass | Result |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of records) {
      lines.push(`| [#${r.number} ${cell(r.title)}](${r.url}) | ${r.author ?? "unknown"} | ${r.mergedBy ?? "unknown"} | ${r.approvedBy.join(", ") || "none"} | ${r.ticket ?? "none"} | ${r.checks} | ${r.bypass} | ${r.exceptions.join(", ") || "ok"} |`);
    }
    lines.push("");
  }
  if (input.bypassUnknown) lines.push("Rule bypasses could not be read with the token, so the Bypass column says unknown.", "");
  if (flagged.length > 0) {
    lines.push("## Exceptions", "");
    for (const r of flagged) {
      lines.push(`### [#${r.number} ${cell(r.title)}](${r.url})`, "");
      for (const kind of r.exceptions) lines.push(`- ${kind}: ${input.explanations.get(`${r.number}:${kind}`) ?? "No explanation recorded."}`);
      lines.push("");
    }
  }
  if (input.vulns) lines.push(...vulnerabilitySection(input.vulns));
  lines.push("The facts above were computed from GitHub; the explanations are the reviewer's confirmed text.", "");
  return lines.join("\n");
}
