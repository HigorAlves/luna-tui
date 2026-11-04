// An Evidence Pack as markdown: a marked section for the PR body and one comment. Pure. What goes in
// is a model's and a container's text on a public page, so it is flattened (no newline in a cell, no
// HTML comment, no `@mention`) and a host path is never printed.
import type { EvidencePack } from "@hardness/contracts";

export const SECTION_START = "<!-- luna-evidence:start -->";
export const SECTION_END = "<!-- luna-evidence:end -->";
export const COMMENT_MARKER = "<!-- luna-evidence-comment -->";

/** GitHub's limit is 65 536 characters; a body keeps some room. */
export const BODY_CAP = 60_000;

/** A line of someone else's text made safe to print: one line, no HTML comment, no mention, no table break. */
function safe(text: string, table = false): string {
  const flat = text
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/\s+/g, " ")
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b")
    .trim();
  return table ? flat.replace(/\|/g, "\\|") : flat;
}

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

function duration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function mediaLine(pack: EvidencePack, m: EvidencePack["media"][number]): string {
  const base = isWeb(m.url) ? `[${safe(m.label)}](${m.url})` : `${safe(m.label)} (local copy)`;
  if (m.kind !== "video" || !pack.video) return `- ${base}`;
  const scores = Object.values(pack.video.scores);
  const mean = scores.length ? `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}/10` : null;
  return `- ${base} · ${duration(pack.video.durationS)} · critic: ${pack.video.verdict}${mean ? `, ${mean}` : ""}`;
}

export interface SectionOptions {
  maxChars?: number;
}

/** The pack as the section a PR body carries, between its markers. The scenario table gives way first when it is over `maxChars`. */
export function renderEvidenceSection(pack: EvidencePack, options: SectionOptions = {}): string {
  const cap = options.maxChars ?? BODY_CAP;
  const build = (rows: number): string => {
    const shown = pack.scenarios.slice(0, rows);
    const hidden = pack.scenarios.length - shown.length;
    const lines = [
      SECTION_START,
      "## Evidence",
      "",
      safe(pack.summary),
      "",
      `**Format** ${pack.format} · **Commit** \`${pack.commitSha.slice(0, 7)}\` · **Risk** ${pack.risk}`,
      ...(pack.note ? ["", `> Degraded: ${safe(pack.note)}`] : []),
      ...(pack.scenarios.length
        ? ["", "| Scenario | Proof | Result |", "|---|---|---|", ...shown.map((s) => `| ${safe(s.text, true)} | ${s.test ? safe(s.test, true) : "none"} | ${s.result} |`), ...(hidden > 0 ? [`| … ${hidden} more | | |`] : [])]
        : []),
      ...(pack.findings.length ? ["", "### Findings", ...pack.findings.map((f) => `- ${safe(f)}`)] : []),
      ...(pack.outOfMap.length ? ["", "### Outside the plan's map", ...pack.outOfMap.map((o) => `- ${safe(o)}`)] : []),
      "",
      `**Rollback.** ${safe(pack.rollback)}`,
      "",
      `**How to verify.** ${safe(pack.howToVerify)}`,
      ...(pack.media.length ? ["", "### Media", ...pack.media.map((m) => mediaLine(pack, m))] : []),
      SECTION_END,
    ];
    return lines.join("\n");
  };
  let rows = pack.scenarios.length;
  let text = build(rows);
  // Table rows first: halve until it fits, then settle by single rows.
  while (text.length > cap && rows > 0) {
    rows = text.length > cap * 1.5 ? Math.floor(rows / 2) : rows - 1;
    text = build(rows);
  }
  if (text.length <= cap) return text;
  // Something other than the table is too big: cut the middle and keep the end marker.
  const tail = `\n… (cut to fit)\n${SECTION_END}`;
  return text.slice(0, cap - tail.length) + tail;
}

/** The body without a previously merged section, and the blank lines it left. */
export function stripSection(body: string): string {
  const start = body.indexOf(SECTION_START);
  if (start === -1) return body;
  const end = body.indexOf(SECTION_END, start);
  if (end === -1) return body;
  const before = body.slice(0, start).replace(/\n+$/, "");
  const after = body.slice(end + SECTION_END.length).replace(/^\n+/, "");
  return before && after ? `${before}\n\n${after}` : `${before}${after}`;
}

/** Replaces the body's marked section with `section`, or appends it. */
export function mergeSection(body: string, section: string): string {
  const start = body.indexOf(SECTION_START);
  const end = start === -1 ? -1 : body.indexOf(SECTION_END, start);
  if (start !== -1 && end !== -1) return body.slice(0, start) + section.replace(/\n+$/, "") + body.slice(end + SECTION_END.length);
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${section}` : section;
}

/** The comment Ship upserts: the section plus a marker to find it by. */
export function renderEvidenceComment(pack: EvidencePack, options: SectionOptions = {}): string {
  return `${renderEvidenceSection(pack, { maxChars: (options.maxChars ?? BODY_CAP) - COMMENT_MARKER.length - 1 })}\n${COMMENT_MARKER}`;
}
