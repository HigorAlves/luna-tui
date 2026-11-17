// Rows of the company brain for the compliance side (RFC 0010, wave 6): the regimes a repository declares, the incidents the machine folded,
// and the policy, control and answer pages of a wiki. Pure. The graph holds names and paths: no timeline line, signal payload, page body or
// answer text goes in. Every title passes the secret and personal-data screen first, as admission's text does.
import { createHash } from "node:crypto";
import { ComplianceRegime, brainEdge, brainNode, brainSlug, brainTime, type BrainRow } from "@hardness/contracts";

import { assessedBreach } from "../breach.ts";
import type { Incident } from "../incident.ts";
import { repoRows, safeTitle, type BrainRepo } from "./rows.ts";

const REGIME_NAME: Record<ComplianceRegime, string> = { soc2: "SOC 2", hipaa: "HIPAA", gdpr: "GDPR", lgpd: "LGPD", us_privacy: "US privacy" };
const KNOWN = new Set<string>(ComplianceRegime.options);

const regimeRow = (id: string): BrainRow => brainNode("Regime", { slug: brainSlug("regime", id), name: REGIME_NAME[id as ComplianceRegime] });

/** The repository's row, then a Regime row and an edge for each regime of the enum the list names; any other name is dropped. */
export function regimeRows(repo: BrainRepo, regimes: readonly string[]): BrainRow[] {
  const rows: BrainRow[] = [...repoRows(repo)];
  const repoSlug = brainSlug("repo", repo.slug);
  for (const id of [...new Set(regimes)].filter((name) => KNOWN.has(name))) rows.push(regimeRow(id), brainEdge("RepoUnderRegime", repoSlug, brainSlug("regime", id)));
  return rows;
}

const SLUG_LONG = 150;

/** An incident id holds `:` and `/` and sometimes `@` and spaces; a slug takes none of the last two. A long one keeps its head and a hash of the whole. */
function incidentId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._:/#-]+/g, "-");
  return safe.length > SLUG_LONG ? `${safe.slice(0, 100)}${createHash("sha256").update(safe).digest("hex").slice(0, 12)}` : safe;
}

/** The incident, then each regime its breach assessment named, with an edge. `breach` is null with no good assessment, true when it found a regime. */
export function incidentRows(incident: Incident): BrainRow[] {
  const slug = brainSlug("incident", incidentId(incident.id));
  const assessment = assessedBreach(incident.breach);
  const rows: BrainRow[] = [
    brainNode("Incident", {
      slug,
      title: safeTitle(incident.title),
      severity: incident.severity,
      status: incident.status,
      service: incident.service ? safeTitle(incident.service) : null,
      breach: assessment ? assessment.regimes.length > 0 : null,
      started_at: brainTime(incident.startedAt),
      resolved_at: incident.resolvedAt ? brainTime(incident.resolvedAt) : null,
    }),
  ];
  for (const regime of assessment?.regimes ?? []) rows.push(regimeRow(regime), brainEdge("IncidentUnderRegime", slug, brainSlug("regime", regime)));
  return rows;
}

const FOLDERS = [
  { prefix: "Compliance/Controls/", type: "Control", kind: "control" },
  { prefix: "Compliance/Policies/", type: "Control", kind: "policy" },
  { prefix: "Compliance/Answers/", type: "Answer", kind: null },
] as const;

/** The first markdown heading, else the file name as words. */
function titleOf(page: { path: string; text: string }): string {
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(page.text);
  if (heading) return heading[1]!;
  return (page.path.split("/").pop() ?? page.path).replace(/\.md$/, "").replace(/[-_]/g, " ");
}

function pageId(repo: BrainRepo, path: string): string {
  const id = `${repo.slug}/${path.replace(/[\s\p{Cc}]+/gu, "-")}`;
  return id.length > 190 ? `${id.slice(0, 150)}${createHash("sha256").update(id).digest("hex").slice(0, 12)}` : id;
}

/**
 * The repository's row, then a Control or Answer row and its edge for each page under the three folders; any other page is skipped.
 * Control and Answer have no retired status: a page that left the wiki stays in the graph until a rebuild. Nothing here changes with
 * time, so a page unchanged gives a row deeply equal to the held one and no `held` is needed.
 */
export function pageRows(pages: readonly { path: string; text: string }[], repo: BrainRepo): BrainRow[] {
  const rows: BrainRow[] = [...repoRows(repo)];
  const repoSlug = brainSlug("repo", repo.slug);
  for (const page of pages) {
    const folder = FOLDERS.find((f) => page.path.startsWith(f.prefix));
    if (!folder) continue;
    const title = safeTitle(titleOf(page));
    const id = pageId(repo, page.path);
    if (folder.type === "Control") {
      const slug = brainSlug("control", id);
      rows.push(brainNode("Control", { slug, title, kind: folder.kind, path: page.path }), brainEdge("ControlOfRepo", slug, repoSlug));
    } else {
      const slug = brainSlug("answer", id);
      rows.push(brainNode("Answer", { slug, question: title, path: page.path }), brainEdge("AnswerOfRepo", slug, repoSlug));
    }
  }
  return rows;
}
