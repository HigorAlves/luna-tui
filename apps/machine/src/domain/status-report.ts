// The weekly status for leadership (RFC 0008, wave 7): the page the person approves, and the week's arithmetic. Pure: no I/O.
// The facts are the machine's; the model's text is the reading of them, so each line of it is flattened to one safe line, and
// the appendix at the foot is computed by code from the same facts. The `## Summary` section is what goes to the channel.
import type { StatusReportAnswer, StatusReportContext } from "@hardness/contracts";

import { postable } from "./postable.ts";

const DAY = 86_400_000;

/** `Status/<week>.md`, in the home wiki. */
export const statusPath = (week: string): string => `Status/${week}.md`;

/** GitHub addresses a wiki page by its basename without `.md`, whatever folder the file sits in. */
export function wikiPageUrl(repo: string, path: string): string {
  const base = path.split("/").at(-1)!.replace(/\.md$/, "");
  return `https://github.com/${repo}/wiki/${base}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** The calendar date of a UTC-based day count, `YYYY-MM-DD`. */
const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The ISO 8601 week of a date, by its local calendar day: `2026-W46`. */
export function isoWeek(date: Date): string {
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  // The Thursday of the week decides the year, and the week is the count of Thursdays since that year began.
  const thursday = new Date(day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${pad(week)}`;
}

/** The Monday and the Sunday of an ISO week, `YYYY-MM-DD`. */
export function weekBounds(week: string): { from: string; to: string } {
  const [year, number] = week.split("-W").map(Number) as [number, number];
  // The fourth of January is always in week 1.
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (number - 1) * 7 * DAY;
  return { from: dateOf(monday), to: dateOf(monday + 6 * DAY) };
}

const line = (text: string): string => postable(text, 600);
const bullets = (items: string[], none: string): string[] => (items.length > 0 ? items.map((i) => `- ${line(i)}`) : [none]);
const pct = (n: number | null): string => (n === null ? "unknown" : `${Math.round(n * 100)}%`);

export function statusPage(week: string, answer: StatusReportAnswer, facts: StatusReportContext): string {
  const m = facts.metrics;
  const c = facts.compliance;
  const capacity = facts.capacity
    ? [`- Over agent capacity: ${facts.capacity.answers.overAgentCapacity ? "yes" : "no"}`, `- Over review capacity: ${facts.capacity.answers.overReviewCapacity ? "yes" : "no"}`, `- Items at risk: ${facts.capacity.answers.atRisk}`]
    : ["Not assessed."];
  const inFlight = [...facts.inFlight.map((i) => `${line(i.title)} (${i.state})`), ...facts.blocked.map((b) => `${line(b.title)}, blocked: ${line(b.why)}`)];
  const appendix = [
    `- Cards: ${m.created} created, ${m.closed} closed, ${m.open} open, ${m.waitingOnYou} waiting on you`,
    `- Lead time: ${m.leadTimeHours === null ? "unknown" : `${m.leadTimeHours} h`}`,
    `- First pass: ${pct(m.firstPassRate)}`,
    `- Escalation rate: ${pct(m.escalationRate)}`,
    `- Cost: $${m.costUsd.toFixed(2)}`,
    ...facts.merged.map((x) => `- ${x.repo}: ${x.count} PRs merged`),
    ...c.evidence.map((e) => `- Change evidence: ${e.repo} ${e.period}, ${e.exceptions} exceptions`),
    ...c.access.map((a) => `- Access review: ${a.org} ${a.period}, ${a.flags} flags, ${a.signed ? "signed" : "not signed"}`),
    ...c.incidents.map((i) => `- Incident: [${i.severity}, ${i.status}] ${line(i.title)}${i.nextDeadline ? `; next deadline ${i.nextDeadline.regime} ${i.nextDeadline.at}` : ""}`),
    ...c.vulns.map((v) => `- Vulnerability: ${v.repo} ${v.severity}, due ${v.deadline}, ${v.overdue ? "overdue" : "not overdue"}`),
    ...c.waitingDrafts.map((d) => `- Draft waiting: ${d.kind}, ${line(d.title)}`),
  ];
  return [
    `# Status, ${week}`,
    "",
    `${facts.from} to ${facts.to}. The sections up to Asks are written from the facts at the foot of the page; the facts are the record.`,
    "",
    "## Summary",
    "",
    line(answer.summary),
    "",
    "## Headline",
    "",
    line(answer.headline),
    "",
    "## Shipped",
    "",
    ...bullets(answer.shipped, "Nothing."),
    "",
    "## In flight",
    "",
    ...(inFlight.length > 0 ? inFlight.map((i) => `- ${i}`) : ["Nothing."]),
    "",
    "## Risks",
    "",
    ...bullets(answer.risks, "None."),
    "",
    "## Compliance",
    "",
    ...bullets(answer.compliance, "Nothing to report."),
    "",
    "## Capacity",
    "",
    ...capacity,
    "",
    "## Asks",
    "",
    ...bullets(answer.asks, "None."),
    "",
    "## Facts",
    "",
    ...appendix,
    "",
  ].join("\n");
}

/** The text of a page's `## Summary` section: what goes to the channel. A page with no such heading (a person rewrote it) is posted whole. */
export function summaryOf(page: string): string {
  const lines = page.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Summary");
  if (start === -1) return page.trim();
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}
