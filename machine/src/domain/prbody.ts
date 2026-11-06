// The PR title and body, in the caveman-pr shape: a one-line what, terse why bullets from
// the approved plan, the acceptance criteria, `Closes #N` when the PR lands in the source
// repo, and the Jira issue's url when the task is linked (its key opens the title, so Jira's
// GitHub app files the PR under the issue). No attribution, no trailers beyond those lines.
import type { TaskRow } from "./task.ts";
import { type Finding, type StageInput, type TriageRecord, criteriaOf, severityOf } from "@hardness/contracts";

import { safe } from "./evidence-markdown.ts";
import { jiraOf } from "./jira-link.ts";

export const TITLE_MAX = 60;
/** The machine's section of the body is between these; a person's own text outside them is never touched. */
export const PR_START = "<!-- luna:pr:start -->";
export const PR_END = "<!-- luna:pr:end -->";
/** The whole section, leaving room in GitHub's body limit for the Evidence section and a person's own text. */
export const PR_SECTION_CAP = 20_000;
const LINE_CAP = 300;
const LIST_MAX = 60;

export interface PrBodyInput {
  task: TaskRow;
  plan: StageInput["plan"];
  /** `nameWithOwner` of the repo the PR opens in, or null when unknown. */
  repoSlug: string | null;
  /** What the record, the plan and the runs say, when the caller has them. */
  extra?: PrExtra;
}

export interface PrExtra {
  record?: Pick<TriageRecord, "goal"> | null;
  planVersion?: number | null;
  /** Each approved scenario with the file of the test tagged for it. */
  scenarios?: Array<{ id: string; title: string; criterion?: string | null; test?: string | null }>;
  /** Findings, open and closed: only those with no resolution are written, by level. */
  findings?: Finding[];
  outOfMap?: Array<{ path: string; reason: string }>;
  base?: string | null;
  head?: string | null;
}

/** A foreign text made safe for the section: flattened, capped, and unable to hold either marker (a forged end marker would let the section grow on every update). */
const flat = (text: string, cap = LINE_CAP): string => safe(text.replaceAll(PR_START, "").replaceAll(PR_END, "")).slice(0, cap).replaceAll(PR_START, "").replaceAll(PR_END, "");
const short = (sha: string | null | undefined): string => (sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 7) : "unknown");

/** Replaces the body's machine section with `section`, or appends it; everything outside the markers stays. */
export function mergePrSection(body: string, section: string): string {
  const start = body.indexOf(PR_START);
  const end = start === -1 ? -1 : body.indexOf(PR_END, start);
  if (start !== -1 && end !== -1) return body.slice(0, start) + section + body.slice(end + PR_END.length);
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${section}` : section;
}

const bullets = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${flat(line)}`);

export function buildPr({ task, plan, repoSlug, extra }: PrBodyInput): { title: string; body: string } {
  const jira = jiraOf(task);
  const prefix = jira ? `${jira.key}: ` : "";
  const title = prefix + task.title.trim().slice(0, Math.max(1, TITLE_MAX - prefix.length)).trimEnd();
  const why = [...(extra?.record?.goal ? [`- ${flat(extra.record.goal)}`] : []), ...bullets(plan?.brief || task.description || "")];
  const criteria = criteriaOf((plan?.criteria?.length ? plan.criteria : task.criteria) ?? []);
  const sections = [flat(task.title.trim())];
  if (why.length > 0) sections.push(`## Why\n${why.join("\n")}`);
  if (extra?.planVersion != null) sections.push(`Plan version ${extra.planVersion}`);
  if (criteria.length > 0) sections.push(`## Criteria\n${criteria.map((c) => `- [ ] ${flat(c.text)} (${flat(c.id, 20)})`).join("\n")}`);
  if (extra?.scenarios?.length) {
    sections.push(`## Scenarios\n${extra.scenarios.slice(0, LIST_MAX).map((s) => `- ${flat(s.id, 20)}${s.criterion ? ` (${flat(s.criterion, 20)})` : ""}: ${flat(s.title)}, ${s.test ? `test \`${flat(s.test, 200).replace(/`/g, "")}\`` : "no test tagged"}`).join("\n")}`);
  }
  const open = (extra?.findings ?? []).filter((f) => !f.resolution);
  if (open.length > 0) {
    const levels = (["blocker", "should_fix", "nit"] as const).flatMap((level) => {
      const at = open.filter((f) => severityOf(f.severity) === level).slice(0, LIST_MAX);
      return at.length > 0 ? [`### ${level}\n${at.map((f) => `- ${flat(f.title)}${f.path ? ` (${flat(f.path, 120)}:${f.line})` : ""}`).join("\n")}`] : [];
    });
    sections.push(`## Findings still open\n${levels.join("\n\n")}`);
  }
  if (extra?.outOfMap?.length) sections.push(`## Outside the map\n${extra.outOfMap.slice(0, LIST_MAX).map((o) => `- ${flat(o.path, 120)}: ${flat(o.reason)}`).join("\n")}`);
  if (extra && (extra.base || extra.head)) sections.push(`Base ${short(extra.base)}, head ${short(extra.head)}`);
  const source = task.source;
  if (source && (source.kind === "github" || source.kind === "github_pr") && repoSlug && source.repo.toLowerCase() === repoSlug.toLowerCase()) {
    sections.push(`Closes #${source.number}`);
  }
  if (jira) sections.push(`Jira: ${jira.url}`);
  const inner = sections.join("\n\n").replaceAll(PR_START, "").replaceAll(PR_END, "").slice(0, PR_SECTION_CAP - PR_START.length - PR_END.length - 4);
  return { title, body: `${PR_START}\n${inner}\n${PR_END}` };
}
