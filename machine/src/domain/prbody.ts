// The PR title and body, in the caveman-pr shape: a one-line what, terse why bullets from
// the approved plan, the acceptance criteria, `Closes #N` when the PR lands in the source
// repo, and the Jira issue's url when the task is linked (its key opens the title, so Jira's
// GitHub app files the PR under the issue). No attribution, no trailers beyond those lines.
import type { TaskRow } from "./task.ts";
import type { StageInput } from "@hardness/contracts";

import { jiraOf } from "./jira-link.ts";

export const TITLE_MAX = 60;

export interface PrBodyInput {
  task: TaskRow;
  plan: StageInput["plan"];
  /** `nameWithOwner` of the repo the PR opens in, or null when unknown. */
  repoSlug: string | null;
}

const bullets = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);

export function buildPr({ task, plan, repoSlug }: PrBodyInput): { title: string; body: string } {
  const jira = jiraOf(task);
  const prefix = jira ? `${jira.key}: ` : "";
  const title = prefix + task.title.trim().slice(0, Math.max(1, TITLE_MAX - prefix.length)).trimEnd();
  const why = bullets(plan?.brief || task.description || "");
  const criteria = (plan?.criteria?.length ? plan.criteria : task.criteria) ?? [];
  const sections = [task.title.trim()];
  if (why.length > 0) sections.push(`## Why\n${why.join("\n")}`);
  if (criteria.length > 0) sections.push(`## Criteria\n${criteria.map((c) => `- [ ] ${c}`).join("\n")}`);
  const source = task.source;
  if (source && (source.kind === "github" || source.kind === "github_pr") && repoSlug && source.repo.toLowerCase() === repoSlug.toLowerCase()) {
    sections.push(`Closes #${source.number}`);
  }
  if (jira) sections.push(`Jira: ${jira.url}`);
  return { title, body: sections.join("\n\n") };
}
