// The pack's text, written again after a fix pushed at a new head. Pure: no model, no clock (the caller gives `now`). Media, the format,
// the video, the scenarios' results and 12b's `source` are the browser run's and Evidence's, and are not touched here.
import type { EvidencePack } from "@hardness/contracts";

import { SUMMARY_MAX_WORDS } from "./evidence-pack.ts";
import { postable } from "./postable.ts";

export interface RefreshFacts {
  sha: string;
  fix: { scope: "in_place" | "re_verify_partial"; summary: string; at: string };
  /** What the delta review found (empty when no review ran), with how each was resolved. */
  delta: Array<{ id: string; title: string; severity: string; resolution: string | null }>;
  /** The branch's size and files now (host git through `at()`); null when unknown: the stored ones stay. */
  diff: { added: number; removed: number; files: string[] } | null;
  now: string;
}

const MAX_FIXES = 20;
const OLD_SENTENCE = /\s*Fixed after review:[^.]*\.?/g;

const capWords = (text: string, max: number): string => {
  const words = text.trim().split(/\s+/).filter((w) => w !== "");
  return words.length <= max ? text.trim() : words.slice(0, max).join(" ");
};

export function refreshPackText(pack: EvidencePack, facts: RefreshFacts): EvidencePack {
  const fixes = [...(pack.fixes ?? []), { sha: facts.sha, scope: facts.fix.scope, summary: postable(facts.fix.summary, 200), at: facts.fix.at }].slice(-MAX_FIXES);
  const count = fixes.length;
  const after = `${count} ${count === 1 ? "fix" : "fixes"} after review.`;
  const what = pack.diffSummary?.what?.trim();
  const summary = what
    ? capWords(`${what.replace(/[.\s]+$/, "")}. ${after}`, SUMMARY_MAX_WORDS)
    : capWords(pack.summary.replace(OLD_SENTENCE, "").trim(), SUMMARY_MAX_WORDS);
  const known = new Set((pack.findingsDetail ?? []).map((f) => f.id));
  const added = facts.delta.filter((f) => !known.has(f.id));
  const findingsDetail = [...(pack.findingsDetail ?? []), ...added.map((f) => ({ id: f.id, title: f.title, severity: f.severity, resolution: f.resolution }))];
  const findings = [...pack.findings, ...added.map((f) => f.title).filter((t) => !pack.findings.includes(t))];
  const diffSummary = pack.diffSummary && facts.diff ? { ...pack.diffSummary, added: facts.diff.added, removed: facts.diff.removed, files: facts.diff.files } : pack.diffSummary;
  return {
    ...pack,
    commitSha: facts.sha,
    fixes,
    summary,
    findings,
    ...(findingsDetail.length > 0 ? { findingsDetail } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    revision: (pack.revision ?? 1) + 1,
    at: facts.now,
  };
}
