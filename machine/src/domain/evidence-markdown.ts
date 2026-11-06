// An Evidence Pack as markdown: a marked section for the PR body and one comment. Pure. What goes in
// is a model's and a container's text on a public page, so it is flattened (no newline in a cell, no
// HTML, no `@mention`, no `#123` reference) and a host path is never printed.
import type { EvidencePack } from "@hardness/contracts";

export const SECTION_START = "<!-- luna-evidence:start -->";
export const SECTION_END = "<!-- luna-evidence:end -->";
export const COMMENT_MARKER = "<!-- luna-evidence-comment -->";

/** GitHub's limit is 65 536 characters; a body keeps some room. */
export const BODY_CAP = 60_000;

const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Text with every token-shaped string (API keys, GitHub and Slack tokens, AWS key ids, JWTs) replaced by `[redacted]`. */
export function redact(text: string): string {
  return SECRET_SHAPES.reduce((out, shape) => out.replace(shape, "[redacted]"), text);
}

/** A line of someone else's text made safe to print: one line, no HTML at all (a tag can fold the rest of the page away), no mention, no issue reference,
 *  no link or image of its own, no table break. */
export function safe(text: string, table = false): string {
  const flat = redact(text)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b")
    // `Closes #12` in a PR body closes issue 12 on merge: a model's text never gets that power.
    .replace(/#(?=\d)/g, "#\u200b")
    // A link or an image needs its `(` right after the `]`, a reference definition its `:`. A space there leaves the address readable and
    // nothing to click under another name, and no image for the page to fetch. However the label was written: this is the guarantee.
    .replace(/\]([(:])/g, "] $1")
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

const FINDINGS_SHOWN = 20;
const layerCell = (n: { passed: number; total: number } | null | undefined): string => (n ? `${n.passed}/${n.total}` : "none");

/** The results by layer on one line; nothing when the pack has none (a pack from before wave 8). */
function resultsLine(results: NonNullable<EvidencePack["results"]>): string {
  const e2e = results.e2e ? `${layerCell(results.e2e)}${results.e2e.verdict ? ` (${safe(results.e2e.verdict)})` : ""}` : "none";
  const cover = results.coverageDelta ? `coverage +${results.coverageDelta.added} added, ${results.coverageDelta.covered} covered` : "coverage none";
  return `**Results** unit ${layerCell(results.unit)} · integration ${layerCell(results.integration)} · e2e ${e2e} · ${cover}`;
}

/** The change in the implementer's words (each flattened) and its size. */
function changeLine(d: NonNullable<EvidencePack["diffSummary"]>): string | null {
  const words = [d.what, d.why].map((t) => safe(t).replace(/[.\s]+$/, "")).filter((t) => t !== "");
  const size = d.added !== null || d.removed !== null ? `+${d.added ?? 0} −${d.removed ?? 0} in ${d.files.length} file${d.files.length === 1 ? "" : "s"}` : "";
  const text = [...(words.length ? [`${words.join(". ")}.`] : []), ...(size ? [size] : [])].join(" ");
  return text === "" ? null : `**Change** ${text}`;
}

/** Each finding with how it ended: from the detail when the pack has it, else the plain lines. */
function findingLines(pack: EvidencePack): string[] {
  if (pack.findingsDetail && pack.findingsDetail.length > 0) {
    const shown = pack.findingsDetail.slice(0, FINDINGS_SHOWN).map((f) => `- ${safe(f.severity).slice(0, 40)}: ${safe(f.title).slice(0, 300)} (${f.resolution ? safe(f.resolution).slice(0, 40) : "open"})`);
    const hidden = pack.findingsDetail.length - shown.length;
    return [...shown, ...(hidden > 0 ? [`- … ${hidden} more`] : [])];
  }
  return pack.findings.map((f) => `- ${safe(f)}`);
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
      `**Format** ${pack.format} · **Commit** \`${pack.commitSha.slice(0, 7)}\` · **Risk** ${pack.risk}${pack.revision !== undefined && pack.revision > 1 ? ` · **Revision** ${pack.revision}` : ""}`,
      ...(pack.results ? ["", resultsLine(pack.results)] : []),
      ...((pack.diffSummary ? changeLine(pack.diffSummary) : null) ? ["", changeLine(pack.diffSummary!)!] : []),
      ...(pack.note ? ["", `> Degraded: ${safe(pack.note)}`] : []),
      ...(pack.scenarios.length
        ? ["", "| Scenario | Proof | Result |", "|---|---|---|", ...shown.map((s) => `| ${safe(s.text, true)} | ${s.test ? safe(s.test, true) : "none"} | ${s.result === "not_run" ? "not run" : s.result} |`), ...(hidden > 0 ? [`| … ${hidden} more | | |`] : [])]
        : []),
      ...(pack.findings.length || pack.findingsDetail?.length ? ["", "### Findings", ...findingLines(pack)] : []),
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
