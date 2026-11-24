// a11y_audit's answer (RFC 0013, phase 2): findings by WCAG 2.2 success criterion, each from axe or judged, with the page,
// the state, the selector and the evidence files. The machine, not the auditor, turns them into review levels (apps/machine/src/domain/a11y-findings.ts).
import { z } from "zod";

export const WCAG_CRITERION = /^[1-4]\.\d{1,2}\.\d{1,2}$/;

/** The level of each WCAG 2.2 success criterion (4.1.1 is obsolete in 2.2 and left out). */
export const WCAG_LEVEL_OF: Readonly<Record<string, "A" | "AA" | "AAA">> = {
  "1.1.1": "A", "1.2.1": "A", "1.2.2": "A", "1.2.3": "A", "1.2.4": "AA", "1.2.5": "AA", "1.2.6": "AAA", "1.2.7": "AAA", "1.2.8": "AAA", "1.2.9": "AAA",
  "1.3.1": "A", "1.3.2": "A", "1.3.3": "A", "1.3.4": "AA", "1.3.5": "AA", "1.3.6": "AAA",
  "1.4.1": "A", "1.4.2": "A", "1.4.3": "AA", "1.4.4": "AA", "1.4.5": "AA", "1.4.6": "AAA", "1.4.7": "AAA", "1.4.8": "AAA", "1.4.9": "AAA", "1.4.10": "AA", "1.4.11": "AA", "1.4.12": "AA", "1.4.13": "AA",
  "2.1.1": "A", "2.1.2": "A", "2.1.3": "AAA", "2.1.4": "A", "2.2.1": "A", "2.2.2": "A", "2.2.3": "AAA", "2.2.4": "AAA", "2.2.5": "AAA", "2.2.6": "AAA",
  "2.3.1": "A", "2.3.2": "AAA", "2.3.3": "AAA", "2.4.1": "A", "2.4.2": "A", "2.4.3": "A", "2.4.4": "A", "2.4.5": "AA", "2.4.6": "AA", "2.4.7": "AA", "2.4.8": "AAA", "2.4.9": "AAA", "2.4.10": "AAA", "2.4.11": "AA", "2.4.12": "AAA", "2.4.13": "AAA",
  "2.5.1": "A", "2.5.2": "A", "2.5.3": "A", "2.5.4": "A", "2.5.5": "AAA", "2.5.6": "AAA", "2.5.7": "AA", "2.5.8": "AA",
  "3.1.1": "A", "3.1.2": "AA", "3.1.3": "AAA", "3.1.4": "AAA", "3.1.5": "AAA", "3.1.6": "AAA", "3.2.1": "A", "3.2.2": "A", "3.2.3": "AA", "3.2.4": "AA", "3.2.5": "AAA", "3.2.6": "A",
  "3.3.1": "A", "3.3.2": "A", "3.3.3": "AA", "3.3.4": "AA", "3.3.5": "AAA", "3.3.6": "AAA", "3.3.7": "A", "3.3.8": "AA", "3.3.9": "AAA",
  "4.1.2": "A", "4.1.3": "AA",
};

export const A11yFinding = z
  .object({
    criterion: z.string().regex(WCAG_CRITERION),
    level: z.enum(["A", "AA", "AAA"]),
    source: z.enum(["axe", "judged"]),
    /** The axe rule id; null for a judged finding. */
    rule: z.string().max(80).nullable(),
    /** axe's impact; null for a judged finding. */
    impact: z.enum(["critical", "serious", "moderate", "minor"]).nullable(),
    page: z.string().max(300),
    state: z.string().max(80),
    selector: z.string().max(300),
    summary: z.string().max(300),
    /** File names the auditor wrote under /out/files/a11y/: a screenshot, the axe report. */
    evidence: z.array(z.string().max(120)).max(5),
    fix: z.string().max(300).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .refine((f) => (f.source === "axe" ? f.rule !== null && f.impact !== null : f.rule === null && f.impact === null), { message: "an axe finding names its rule and impact; a judged one names neither" });
export type A11yFinding = z.infer<typeof A11yFinding>;

/** What the machine hands the audit: the WCAG 2.2 level the repo audits at. */
export const A11yContext = z.object({ level: z.enum(["AA", "AAA"]) });
export type A11yContext = z.infer<typeof A11yContext>;

export const A11yAuditAnswer = z.object({
  summary: z.string().max(600),
  pages: z.array(z.object({ page: z.string().max(300), states: z.array(z.string().max(80)).max(10), axe: z.enum(["ran", "failed"]) })).max(20),
  findings: z.array(A11yFinding).max(40),
  kind: z.enum(["done", "escalated"]).optional(),
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type A11yAuditAnswer = z.infer<typeof A11yAuditAnswer>;
