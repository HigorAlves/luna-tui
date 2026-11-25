// The compliance review beside a review: when the repo's luna.yaml declares regimes, the compliance lead
// reads the same diff with the repo's control pages from its wiki, and its findings join the review before
// the verdict is computed. It never blocks by failing: a wiki that cannot be read means no controls, a run
// that fails means no findings, and each says so in a note.
import { COMPLIANCE_CONTROL_CHARS, COMPLIANCE_CONTROL_PAGES, ComplianceReviewAnswer, type ComplianceRegime, type ComplianceReviewContext, type Finding, type ReviewContext } from "@hardness/contracts";

import type { StageContext, StageResult } from "../ports.ts";
import type { Wiki } from "../wiki.ts";
import type { PassMount } from "./review-helpers.ts";

export interface ComplianceDeps {
  /** The regimes the repo declares in luna.yaml; none skips the review. */
  regimes: (repoPath: string | null) => Promise<readonly ComplianceRegime[]>;
  /** Where the control pages are read from. */
  wiki: Wiki;
  /** Runs the compliance_review pack, as a sub-run beside the stage's own pack. */
  run: (context: StageContext, review: ReviewContext | null, compliance: ComplianceReviewContext, mounts?: readonly PassMount[]) => Promise<StageResult>;
}

export interface ComplianceOutcome {
  /** The compliance findings, in review-contract shape with the regime, clause and control in the text. */
  findings: Finding[];
  /** Inline comments for the findings the review posts. */
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; body: string }>;
  summary: string;
  regimesRun: ComplianceRegime[];
  notes: string[];
  /** What the sub-run cost, for the stage to add to its own: absent when it did not report any. */
  usage?: StageResult["usage"];
}

/** `[GDPR Art. 5(1)(c) · Compliance/Controls/PRIV-LOG-01.md]`: what law and which company control a finding stands on. */
export const citation = (f: { clause: string; control: string | null }): string => `[${f.clause}${f.control ? ` · ${f.control}` : ""}]`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the compliance review of `review` for the repo `slug`; null when the repo declares no regime. */
export async function runCompliance(deps: ComplianceDeps, context: StageContext, slug: string, review: ReviewContext | null, mounts?: readonly PassMount[]): Promise<ComplianceOutcome | null> {
  const regimes = [...(await deps.regimes(context.task.repoPath ?? null).catch(() => []))];
  if (regimes.length === 0) return null;
  const notes: string[] = [];
  let controls: ComplianceReviewContext["controls"] = [];
  try {
    // Only the controls and the policies: the access reviews and the answers sit beside them under Compliance/.
    const pages = [...(await deps.wiki.readPages(slug, "Compliance/Controls/")), ...(await deps.wiki.readPages(slug, "Compliance/Policies/"))];
    let chars = 0;
    let left = false;
    for (const page of pages) {
      if (controls.length >= COMPLIANCE_CONTROL_PAGES) {
        left = true;
        break;
      }
      if (chars + page.text.length > COMPLIANCE_CONTROL_CHARS) {
        left = true;
        continue;
      }
      controls.push({ path: page.path, text: page.text });
      chars += page.text.length;
    }
    if (left) notes.push(`some control pages were left out (at most ${COMPLIANCE_CONTROL_PAGES} pages and ${COMPLIANCE_CONTROL_CHARS} characters)`);
  } catch (error) {
    controls = [];
    notes.push(`the control pages could not be read (${messageOf(error)}); the review ran without them`);
  }
  let usage: StageResult["usage"];
  const skipped = (why: string): ComplianceOutcome => ({ findings: [], comments: [], summary: "", regimesRun: [], notes: [...notes, `the compliance review did not run: ${why}`], ...(usage ? { usage } : {}) });
  let pack: StageResult;
  try {
    pack = await deps.run({ ...context, runId: `${context.runId}-compliance`, started: undefined, resume: undefined, engine: undefined }, review, { repo: slug, regimes, controls }, mounts);
  } catch (error) {
    return skipped(messageOf(error));
  }
  usage = pack.usage;
  if (pack.outcome !== "pass") return skipped(`the pack ${pack.outcome === "fail" ? "failed" : pack.outcome}`);
  const parsed = ComplianceReviewAnswer.safeParse(pack.detail?.answer);
  if (!parsed.success) return skipped("its answer did not parse");
  const { findings, summary, regimesRun } = parsed.data;
  return {
    findings: findings.map(({ regime: _regime, clause, control, ...finding }) => ({ ...finding, title: `${finding.title} ${citation({ clause, control })}` })),
    comments: findings.map((f) => ({ path: f.path, line: f.line, side: f.side === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const), body: `${f.title}: ${f.body} ${citation(f)}` })),
    summary,
    regimesRun,
    notes,
    ...(usage ? { usage } : {}),
  };
}
