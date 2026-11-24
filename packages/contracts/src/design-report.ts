// The design block of the e2e stage and of the Verify report (RFC 0013, phase 3): what the gate shows and the PR's Design & accessibility block reads. Not `DesignReport` (api.ts): that one is the on-demand report.
// Apart from design-parity.ts because it holds review Findings, and stage.ts imports design-parity.ts.
import { z } from "zod";

import { PairRow } from "./design-parity.ts";
import { Finding } from "./stage.ts";

const Counts = z.object({ blocker: z.number().int(), should_fix: z.number().int(), nit: z.number().int(), waived: z.number().int() });
export const GateWhy = z.enum(["open_findings", "low_confidence", "not_compared", "rounds_spent"]);
export type GateWhy = z.infer<typeof GateWhy>;

export const VerifyDesignReport = z.object({
  wcag: z.enum(["A", "AA", "AAA"]).nullable(),
  a11y: z.object({ mode: z.enum(["gate", "advisory"]), counts: Counts }).nullable(),
  parity: z
    .object({
      ran: z.boolean(),
      runId: z.string().nullable(),
      confidence: z.number().nullable(),
      bar: z.number(),
      designInput: z.enum(["complete", "partial", "missing"]),
      frames: z.array(PairRow),
      counts: Counts,
      summary: z.string(),
    })
    .nullable(),
  /** The design findings (parity and accessibility), at most 40, with their finding_classify rows' record ids. */
  findings: z.array(Finding).max(40),
  classified: z.array(z.object({ id: z.string(), recordId: z.string().optional() })).optional(),
  gate: z.object({ fires: z.boolean(), why: z.array(GateWhy) }),
});
export type VerifyDesignReport = z.infer<typeof VerifyDesignReport>;
