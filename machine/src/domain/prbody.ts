// The PR title and body, in the caveman-pr shape: a one-line what, terse why bullets from
// the approved plan, the acceptance criteria, and `Closes #N` when the PR lands in the source
// repo. No attribution, no trailers beyond the close line.
import type { TaskRow } from "./task.ts";
import type { StageInput } from "@hardness/contracts";

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
  const title = task.title.trim().slice(0, TITLE_MAX).trimEnd();
  const why = bullets(plan?.brief || task.description || "");
  const criteria = (plan?.criteria?.length ? plan.criteria : task.criteria) ?? [];
  const sections = [task.title.trim()];
  if (why.length > 0) sections.push(`## Why\n${why.join("\n")}`);
  if (criteria.length > 0) sections.push(`## Criteria\n${criteria.map((c) => `- [ ] ${c}`).join("\n")}`);
  const source = task.source;
  if (source && repoSlug && source.repo.toLowerCase() === repoSlug.toLowerCase()) {
    sections.push(`Closes #${source.number}`);
  }
  return { title, body: sections.join("\n\n") };
}
