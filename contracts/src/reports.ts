// The v2.2 diagram's Build Report and Verify Report: what Build hands to Verify and what Verify hands to
// Evidence. The machine assembles both from what the stages already log (machine/src/application/reports.ts);
// a field the machine cannot know yet is null, with the wave that fills it named beside it.
import { z } from "zod";

import { CoverageSummary, Finding } from "./stage.ts";

/** One implementer run of the build. */
export const BuildRun = z.object({
  attempt: z.number().int(),
  outcome: z.string().nullable(),
  engine: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type BuildRun = z.infer<typeof BuildRun>;

export const BuildReport = z.object({
  branch: z.string().nullable(),
  /** The branch the PR targets: nothing logs it before wave 11. */
  base: z.string().nullable(),
  headSha: z.string().nullable(),
  /** The sandbox's environment hash: null until wave 11. */
  envHash: z.string().nullable(),
  diffSummary: z.object({ added: z.number().int().nullable(), removed: z.number().int().nullable(), files: z.array(z.string()) }),
  /** Files the implementer declared outside the plan, with its reason. */
  declaredFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** Which scenario a test proves, and whether it failed before and passed after: empty until wave 10 tags tests. */
  tests: z.array(z.object({ scenario: z.string(), before: z.enum(["fail", "pass"]).nullable(), after: z.enum(["fail", "pass"]).nullable() })),
  runs: z.array(BuildRun),
  /** Tokens spent: null until wave 10. */
  tokens: z.number().nullable(),
  minutes: z.number(),
  scopeCheck: z.object({ clean: z.boolean(), issues: z.array(z.string()) }),
  version: z.number().int(),
});
export type BuildReport = z.infer<typeof BuildReport>;

export const VerifyReport = z.object({
  prNumber: z.number().int().nullable(),
  headSha: z.string().nullable(),
  /** v2 findings, with a resolution where the log shows how one ended. */
  findings: z.array(Finding),
  tests: z.object({ passed: z.number().int(), total: z.number().int() }),
  /** The patch-coverage summary of the last verifying run. */
  coverageDelta: CoverageSummary.nullable(),
  e2e: z.object({
    verdict: z.string().nullable(),
    scenarios: z.array(z.object({ text: z.string(), result: z.string() })),
    artifacts: z.array(z.string()),
  }),
  /** Whether the sandbox reproduces the failure: null until wave 11. */
  envReproduction: z.string().nullable(),
  /** Where a person overrode a verdict: empty until wave 12. */
  overrides: z.array(z.object({ finding: z.string(), by: z.string(), reason: z.string() })),
  version: z.number().int(),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

/** `GET /tasks/:id`'s `reports`: each is null until the stage that makes it has passed. */
export const TaskReports = z.object({ build: BuildReport.nullable(), verify: VerifyReport.nullable() });
export type TaskReports = z.infer<typeof TaskReports>;
