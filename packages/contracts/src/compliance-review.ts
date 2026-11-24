// The compliance review's answer: the review contract's finding (stage.ts `Finding`) with the regime it
// answers to, the clause it cites and the company's own control. Its context is in stage.ts, with the others.
import { z } from "zod";

import { ComplianceRegime } from "./compliance.ts";
import { Finding } from "./stage.ts";

/** A finding the compliance lead merged: where the diff creates the risk, and the law and the control it breaks. */
export const ComplianceFinding = Finding.extend({
  regime: ComplianceRegime,
  /** The clause, such as "GDPR Art. 5(1)(c)" or "HIPAA 45 CFR 164.312(b)". */
  clause: z.string().min(1),
  /** The path of the company's control or policy page that applies, or null when none does. */
  control: z.string().nullable(),
});
export type ComplianceFinding = z.infer<typeof ComplianceFinding>;

/** compliance_review: the findings of every regime that ran, one review. `regimesRun` is the declared regimes whose reviewer the lead dispatched; the summary says why it skipped the others. */
export const ComplianceReviewAnswer = z.object({
  summary: z.string(),
  findings: z.array(ComplianceFinding),
  regimesRun: z.array(ComplianceRegime),
});
export type ComplianceReviewAnswer = z.infer<typeof ComplianceReviewAnswer>;
