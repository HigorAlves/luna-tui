// The PR title and body a reviewer reads. When the repository has a PR template, its headings are filled; otherwise the body is the
// caveman-pr shape (orc's skill): at most Why, What changed, How tested and Notes, each terse, and the trailers (`Closes #N`, the Jira
// issue's url). Never the plan's criteria as a checklist, the scenario list, plan versions or shas: the Evidence section and the board
// hold those. The Jira key opens the title, so Jira's GitHub app files the PR under the issue. No attribution. Pure.
import type { TaskRow } from "./task.ts";
import { type Finding, type StageInput, type TriageRecord, severityOf } from "@hardness/contracts";

import { isDocsOnly } from "./docs-only.ts";
import { safe } from "./evidence-markdown.ts";
import { jiraOf } from "./jira-link.ts";

export const TITLE_MAX = 72;
/** The machine's section of the body is between these; a person's own text outside them is never touched. */
export const PR_START = "<!-- luna:pr:start -->";
export const PR_END = "<!-- luna:pr:end -->";
/** The whole section, leaving room in GitHub's body limit for the Evidence section and a person's own text. */
export const PR_SECTION_CAP = 20_000;
/** Where a repository keeps its PR template, in GitHub's order; the first that exists is followed. */
export const PR_TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "docs/PULL_REQUEST_TEMPLATE.md"];
const LINE_CAP = 400;
const STEPS_SHOWN = 6;
const FINDINGS_SHOWN = 3;

export interface PrBodyInput {
  task: TaskRow;
  plan: StageInput["plan"];
  /** `nameWithOwner` of the repo the PR opens in, or null when unknown. */
  repoSlug: string | null;
  /** What the record, the plan and the runs say, when the caller has them. */
  extra?: PrExtra;
}

export interface PrExtra {
  record?: Pick<TriageRecord, "goal"> & Partial<Pick<TriageRecord, "kind">> | null;
  planVersion?: number | null;
  /** Each approved scenario with the file of the test tagged for it. */
  scenarios?: Array<{ id: string; title: string; criterion?: string | null; test?: string | null }>;
  /** Findings, open and closed: only those with no resolution are named. */
  findings?: Finding[];
  outOfMap?: Array<{ path: string; reason: string }>;
  base?: string | null;
  head?: string | null;
  /** The PR of the card this one is stacked on. */
  stack?: { number: number };
  /** The repository's PR template (from its default branch), when it has one: its headings are what the body fills. */
  template?: string | null;
}

/** A foreign text made safe for the section: flattened, capped, and unable to hold either marker (a forged end marker would let the section grow on every update). */
const flat = (text: string, cap = LINE_CAP): string => safe(text.replaceAll(PR_START, "").replaceAll(PR_END, "")).slice(0, cap).replaceAll(PR_START, "").replaceAll(PR_END, "");

/** Replaces the body's machine section with `section`, or appends it; everything outside the markers stays. */
export function mergePrSection(body: string, section: string): string {
  const start = body.indexOf(PR_START);
  const end = start === -1 ? -1 : body.indexOf(PR_END, start);
  if (start !== -1 && end !== -1) return body.slice(0, start) + section + body.slice(end + PR_END.length);
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${section}` : section;
}

const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?:\s/;
const KIND_TYPE: Record<string, string> = { bug: "fix", fix: "fix", feature: "feat", feat: "feat", chore: "chore", task: "chore", refactor: "refactor", docs: "docs" };

/** The first sentence or two of a text, as one line: the why a reviewer needs, not the brief. */
function firstSentences(text: string, max = 2): string {
  const flatText = text.replace(/\s+/g, " ").trim();
  // A sentence ends at a stop followed by a space: `contributing.md` and `v1.2` are not two sentences.
  return flatText.split(/(?<=[.!?])\s+/).slice(0, max).join(" ").trim();
}

/** The parts every shape is filled from. */
interface Parts {
  title: string;
  why: string | null;
  changed: string[];
  tested: string;
  notes: string[];
  trailers: string[];
}

function partsOf({ task, plan, repoSlug, extra }: PrBodyInput): Parts {
  const jira = jiraOf(task);
  const steps = (plan?.slices ?? []) as Array<{ title?: string; touchpoints?: string[] }>;
  const touched = steps.flatMap((s) => s.touchpoints ?? []);
  // A conventional-commit title: the card's own when it already is one, else its kind's type (`docs` for a docs-only plan).
  const raw = task.title.trim();
  const type = isDocsOnly(touched) ? "docs" : KIND_TYPE[(extra?.record?.kind ?? "").toLowerCase()] ?? "feat";
  const subject = CONVENTIONAL.test(raw) ? raw : `${type}: ${raw.charAt(0).toLowerCase()}${raw.slice(1)}`;
  const prefix = jira ? `${jira.key}: ` : "";
  const title = prefix + subject.slice(0, Math.max(1, TITLE_MAX - prefix.length)).trimEnd();

  const whySource = extra?.record?.goal || plan?.brief || task.description || "";
  const why = whySource.trim() ? flat(firstSentences(whySource)) : null;
  // What changed only when the diff is more than one step: the plan's step titles, a few.
  const changed = steps.length > 1 ? steps.slice(0, STEPS_SHOWN).flatMap((s) => (s.title ? [flat(s.title, 160)] : [])) : [];

  const scenarios = extra?.scenarios ?? [];
  const withTests = scenarios.filter((s) => s.test).length;
  const tested = scenarios.length
    ? `Verify judged ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}${withTests ? `, ${withTests} with a test written before the code` : ""}; the repo's checks ran in the sandbox. Evidence below.`
    : "The repo's checks ran in the sandbox. Evidence below.";

  const notes: string[] = [];
  const parent = extra?.stack?.number;
  if (typeof parent === "number" && Number.isInteger(parent) && parent > 0) notes.push(`Stacked on #${parent}: review that first; this PR shows only its own change and moves to the default branch when #${parent} merges.`);
  const open = (extra?.findings ?? []).filter((f) => !f.resolution);
  if (open.length > 0) {
    const worst = open.filter((f) => severityOf(f.severity) === "blocker").concat(open.filter((f) => severityOf(f.severity) !== "blocker")).slice(0, FINDINGS_SHOWN);
    notes.push(`${open.length} finding${open.length === 1 ? "" : "s"} still open: ${worst.map((f) => `${flat(f.title, 120)}${f.path ? ` (\`${flat(f.path, 100).replace(/`/g, "")}\`)` : ""}`).join("; ")}${open.length > worst.length ? "; …" : ""}`);
  }
  const radius = [...new Set(touched.map((p) => p.split("/")[0] ?? p).filter(Boolean))].slice(0, 3);
  const oneWay = touched.some((p) => /(^|\/)migrations?\//i.test(p) || /\.sql$/i.test(p));
  if (radius.length) notes.push(`Door: ${oneWay ? "one-way (a migration: a revert does not undo it)" : "two-way"} · Blast radius: ${radius.map((r) => `\`${flat(r, 60).replace(/`/g, "")}\``).join(", ")}`);

  const trailers: string[] = [];
  const source = task.source;
  if (source && (source.kind === "github" || source.kind === "github_pr") && repoSlug && source.repo.toLowerCase() === repoSlug.toLowerCase()) trailers.push(`Closes #${source.number}`);
  if (jira) trailers.push(`Jira: ${jira.url}`);
  return { title, why, changed, tested, notes, trailers };
}

/** The caveman-pr body: only the sections that carry something, then the trailers. */
function caveman(p: Parts): string {
  return [
    ...(p.why ? [`## Why\n${p.why}`] : []),
    ...(p.changed.length ? [`## What changed\n${p.changed.map((c) => `- ${c}`).join("\n")}`] : []),
    `## How tested\n${p.tested}`,
    ...(p.notes.length ? [`## Notes\n${p.notes.map((n) => `- ${n}`).join("\n")}`] : []),
    ...(p.trailers.length ? [p.trailers.join("\n")] : []),
  ].join("\n\n");
}

/** What a template heading asks for, by its words. */
function slotOf(heading: string): keyof Pick<Parts, "why" | "changed" | "tested" | "notes" | "trailers"> | null {
  const h = heading.toLowerCase();
  if (/test|qa|verif|how (has|was|to) (this|it) been/.test(h)) return "tested";
  if (/why|motivation|context|problem|summary|description|overview|purpose/.test(h)) return "why";
  if (/what|change|approach|implementation|solution/.test(h)) return "changed";
  if (/risk|note|breaking|deploy|rollout|rollback|impact|caveat|review/.test(h)) return "notes";
  if (/issue|ticket|link|related|close|jira|reference/.test(h)) return "trailers";
  return null;
}

/** The repository's template with each heading it asks for filled: its own text stays where no part fits, without its HTML comments.
 *  A part the template has no heading for is not invented; the trailers always end the body. */
function filled(template: string, p: Parts): string {
  const text = template.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out: string[] = [];
  const used = new Set<string>();
  let i = 0;
  // What comes before the first heading (often a one-line instruction) is kept as it is.
  while (i < lines.length && !/^#{1,6}\s/.test(lines[i]!)) out.push(lines[i++]!);
  while (i < lines.length) {
    const heading = lines[i++]!;
    const body: string[] = [];
    while (i < lines.length && !/^#{1,6}\s/.test(lines[i]!)) body.push(lines[i++]!);
    const slot = slotOf(heading);
    const fill =
      slot === "why" ? p.why
      : slot === "changed" ? (p.changed.length ? p.changed.map((c) => `- ${c}`).join("\n") : null)
      : slot === "tested" ? p.tested
      : slot === "notes" ? (p.notes.length ? p.notes.map((n) => `- ${n}`).join("\n") : null)
      : slot === "trailers" ? (p.trailers.length ? p.trailers.join("\n") : null)
      : null;
    out.push(heading);
    if (fill && slot && !used.has(slot)) {
      used.add(slot);
      // A checklist the template asks the author to tick stays, after the filled text.
      const checklist = body.filter((l) => /^\s*[-*]\s+\[[ xX]\]/.test(l));
      out.push(fill, ...(checklist.length ? ["", ...checklist] : []), "");
    } else out.push(...body);
  }
  const done = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const missingTrailers = p.trailers.filter((t) => !used.has("trailers") && !done.includes(t));
  return missingTrailers.length ? `${done}\n\n${missingTrailers.join("\n")}` : done;
}

export function buildPr(input: PrBodyInput): { title: string; body: string } {
  const p = partsOf(input);
  const template = input.extra?.template?.trim() ? input.extra.template : null;
  const inner = (template ? filled(template, p) : caveman(p)).replaceAll(PR_START, "").replaceAll(PR_END, "").slice(0, PR_SECTION_CAP - PR_START.length - PR_END.length - 4);
  return { title: p.title, body: `${PR_START}\n${inner}\n${PR_END}` };
}
