// The v2.2 diagram's Build Report and Verify Report: what Build hands to Verify and what Verify hands to
// Evidence. The machine assembles both from what the stages already log (machine/src/application/reports.ts);
// a field the machine cannot know yet is null, with the wave that fills it named beside it.
import { z } from "zod";

import { CoverageSummary, Finding } from "./stage.ts";

/** The Diff Summary the implementer writes after reading its own diff. A plain string (an answer from before v2.2) is read as `what`. */
export const DiffSummaryAnswer = z.preprocess(
  (value) => (typeof value === "string" ? { what: value } : value),
  z.object({
    what: z.string().optional(),
    why: z.string().optional(),
    files: z.array(z.object({ path: z.string(), reason: z.string().nullable().optional(), in_code_map: z.boolean().optional() })).optional(),
    flags_added: z.array(z.string()).optional(),
    migrations: z.array(z.string()).optional(),
    risks_noticed: z.array(z.string()).optional(),
    deps_added: z.array(z.string()).optional(),
    todos: z.array(z.string()).optional(),
  }),
);
export type DiffSummaryAnswer = z.infer<typeof DiffSummaryAnswer>;

/** The Diff Summary as the machine stores it: the agent's words, flattened and capped, with what git knows (`in_code_map`, `deps_added`, `todos`) filled by the machine. */
export const DiffSummary = z.object({
  what: z.string(),
  why: z.string(),
  files: z.array(z.object({ path: z.string(), reason: z.string().nullable(), in_code_map: z.boolean() })),
  flags_added: z.array(z.string()),
  migrations: z.array(z.string()),
  risks_noticed: z.array(z.string()),
  deps_added: z.array(z.string()),
  todos: z.array(z.string()),
});
export type DiffSummary = z.infer<typeof DiffSummary>;

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
  /** Which scenario a test proves (and its file), and whether it failed before (red at the tests commit) and passed after: empty when the tests step did not run. */
  tests: z.array(z.object({ scenario: z.string(), before: z.enum(["fail", "pass"]).nullable(), after: z.enum(["fail", "pass"]).nullable(), file: z.string().nullable().optional() })),
  runs: z.array(BuildRun),
  /** Tokens spent, from the runtime's own count; null when no run could count them. */
  tokens: z.number().nullable(),
  minutes: z.number(),
  scopeCheck: z.object({
    clean: z.boolean(),
    issues: z.array(z.string()),
    /** Every issue with its severity (blocker, should_fix, nit): the ones that do not fail the stage ride on to Verify. */
    severities: z.array(z.object({ severity: z.enum(["blocker", "should_fix", "nit"]), kind: z.string(), text: z.string() })).optional(),
  }),
  version: z.number().int(),
  // v2.2, wave 10: all optional, so a report assembled before them still validates.
  /** Each red or green the ledger reported, and each failed regression sweep, in order: the slice or scenario it was about and the commit. */
  iterations: z.array(z.object({ kind: z.enum(["red", "green", "sweep"]), ref: z.string().nullable(), sha: z.string().nullable() })).optional(),
  /** The implementer's own Diff Summary, with git's facts over it. */
  summary: DiffSummary.nullable().optional(),
  /** The budget's limits, to show what was used against. */
  limits: z.object({ max_iterations: z.number(), max_tokens: z.number(), max_minutes: z.number() }).nullable().optional(),
  /** What the tests step did: committed, or skipped (and why, e.g. holdout_cases). */
  testsStep: z.object({ status: z.string(), why: z.string().optional(), commit: z.string().optional(), redCheck: z.string().optional() }).nullable().optional(),
  /** What the regression sweep did: passed, failed, or skipped (a repo with no checks). */
  sweep: z.object({ status: z.string(), ran: z.array(z.string()), note: z.string().optional(), failed: z.array(z.string()).optional() }).nullable().optional(),
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
    /** v2.2: the run by approved scenario, as the machine checked the manifest (artifacts are names of files that exist in the run's folder). */
    rows: z.array(z.object({ scenario: z.string(), title: z.string(), criterion: z.string().nullable().optional(), result: z.string(), seen: z.string(), artifacts: z.array(z.string()) })).optional(),
  }),
  /** Whether the sandbox reproduces the failure: null until wave 11. */
  envReproduction: z.string().nullable(),
  /** Where a person overrode a verdict: empty until wave 12. */
  overrides: z.array(z.object({ finding: z.string(), by: z.string(), reason: z.string() })),
  version: z.number().int(),
  // v2.2, wave 12a: all optional, so a report assembled before them still validates.
  /** Who reviewed: the engine the last verifying run was on and its credential family (`claude`, `codex`, ...). */
  review: z.object({ engine: z.string().nullable(), family: z.string().nullable() }).optional(),
  /** The mutation run's score against the repository's minimum, when it ran. */
  mutation: z.object({ score: z.number(), min: z.number() }).nullable().optional(),
  /** What kind of CI failure the last red run was (real, flake, infra, drift), when one was judged. */
  ciClass: z.string().nullable().optional(),
  /** The failures each loop has had: Verify, the browser run, CI. */
  rounds: z.object({ verify: z.number().int(), e2e: z.number().int(), ci: z.number().int() }).optional(),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

/** `GET /tasks/:id`'s `reports`: each is null until the stage that makes it has passed. */
export const TaskReports = z.object({ build: BuildReport.nullable(), verify: VerifyReport.nullable() });
export type TaskReports = z.infer<typeof TaskReports>;
