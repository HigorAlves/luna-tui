// The stage contract between the machine and the factory runner: the machine writes
// `/in/stage.json` (StageInput) and reads `/out/result.json` (StageOutput). Both sides of
// the seam live in this repository; `factory-contract.test.ts` holds them together.
import { z } from "zod";

/** What a stage run decided. Lives here, not in api.ts, so the two files do not import each other in a loop. */
export const StageOutcome = z.enum(["pass", "fail", "needs_input", "test_change", "escalated"]);
export type StageOutcome = z.infer<typeof StageOutcome>;

/** The tracker item a task came from. */
export const TaskSource = z.object({
  kind: z.literal("github"),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
});
export type TaskSource = z.infer<typeof TaskSource>;

/** A question the stage could not answer alone, with the answer it would pick. */
export const NeedsInputItem = z.object({
  question: z.string(),
  /** Null when the stage has no default to offer. */
  recommended: z.string().nullable(),
});
export type NeedsInputItem = z.infer<typeof NeedsInputItem>;

/** A hard-outward action the stage refused to run inside the sandbox; the board approves it. */
export const RequestedAction = z.object({
  kind: z.enum(["tracker_write", "pr_review_post", "publish"]),
  target: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type RequestedAction = z.infer<typeof RequestedAction>;

export const ArtifactKind = z.enum([
  "qa-manifest",
  "screenshot",
  "video",
  "har",
  "report",
  "test",
  "diff",
  "findings",
  "rules",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** A file a stage produced; `path` is relative to `/out`. */
export const StageArtifact = z.object({
  kind: ArtifactKind,
  path: z.string(),
  label: z.string(),
  sha256: z.string(),
});
export type StageArtifact = z.infer<typeof StageArtifact>;

/** One review finding, as in the review-contract skill. */
export const Finding = z.object({
  path: z.string(),
  line: z.number().int(),
  // The pack answers require path/line/severity/title/body/confidence only; the rest is
  // optional there, so it must be optional here or every run with a finding fails to ingest.
  start_line: z.number().int().nullable().optional(),
  side: z.string().optional(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  suggestion_code: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

/** Pack ids equal the Hardness stage names they run. */
export const PackId = z.enum([
  "triage",
  "test_design",
  "implementing",
  "verifying",
  "e2e",
  "evidence",
  "ci_watch",
  "reviewing_memory",
]);
export type PackId = z.infer<typeof PackId>;

/** One behaviour test_design names: the plan criterion it proves, and how to prove it. */
export const TestCase = z.object({
  title: z.string(),
  criterion: z.string().nullable(),
  /** Free text: what to check, and the repo's own command when one applies. */
  approach: z.string(),
});
export type TestCase = z.infer<typeof TestCase>;

/** Schema 2's shape, read for runs recorded before the schema 3 rename. */
const LegacyTestCase = z.object({
  title: z.string(),
  criterion: z.string().nullable(),
  test: z.string(),
});

/** One scenario verifying proved (or didn't), alongside its code review. */
export const VerifyResult = TestCase.extend({ outcome: z.enum(["pass", "fail"]) });
export type VerifyResult = z.infer<typeof VerifyResult>;

/** The PR, its checks and the failed run's log tail, as ci_watch receives them. */
export const CiContext = z.object({
  pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
  checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string().nullable() })),
  logs: z.string().nullable(),
});
export type CiContext = z.infer<typeof CiContext>;

/** One slice of the implementer's ledger, kept by the runner in `/out/ledger.json`. */
export const LedgerSlice = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(["pending", "red", "green", "committed", "escalated"]),
  commit: z.string().nullable(),
  estLoc: z.number().int().nullable().optional(),
  actualLoc: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type LedgerSlice = z.infer<typeof LedgerSlice>;

export const Ledger = z.object({ schema: z.literal(1), slices: z.array(LedgerSlice) });
export type Ledger = z.infer<typeof Ledger>;

/** What an earlier stage run of the task came to; the retro reads these. */
export const RunSummary = z.object({
  stage: z.string(),
  attempt: z.number().int(),
  outcome: z.string(),
  turns: z.number().int().nullable(),
  costUsd: z.number().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** One of a repo's own checks, from its luna.yaml: a shell line run in `cwd` (the worktree
 *  root by default). With `paths`, it runs only for a change that touches one of them. */
export const CheckSpec = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  cwd: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
});
export type CheckSpec = z.infer<typeof CheckSpec>;

/** A service a repo's code needs beside it (a database, a broker), from its luna.yaml. The
 *  machine runs it next to each stage and check container; `exports` is the env the code
 *  gets, with the service reachable by its key as hostname; `ready` is run inside the
 *  service until it exits 0. */
export const ServiceSpec = z.object({
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  ready: z.string().min(1).optional(),
  exports: z.record(z.string(), z.string()).optional(),
});
export type ServiceSpec = z.infer<typeof ServiceSpec>;

/** A place the e2e stage may drive. `credential` is a reference (`env:NAME`), never a value. */
export const QaTarget = z.object({
  name: z.string(),
  baseUrl: z.string(),
  credential: z.string().nullable().optional(),
});
export type QaTarget = z.infer<typeof QaTarget>;

/** Schema 2 adds `context.testCases`; schema 3 renames its `test` field to `approach`. */
export const StageInput = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  stage: z.string(),
  pack: PackId,
  attempt: z.number().int(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    criteria: z.array(z.string()),
    repoPath: z.string(),
    branch: z.string(),
    source: TaskSource.nullable(),
  }),
  plan: z
    .object({
      brief: z.string(),
      criteria: z.array(z.string()),
      assumptions: z.array(z.string()),
      /** The slices triage proposed, when it split the work. */
      slices: z.array(z.unknown()).optional(),
    })
    .nullable(),
  decisions: z.array(
    z.object({
      at: z.string(),
      decision: z.string(),
      reason: z.string().nullable(),
      answers: z.record(z.string(), z.string()),
    }),
  ),
  priorFindings: z.array(Finding),
  context: z.object({
    projectContext: z.string().nullable(),
    /** The cases approved at the test check, for implementing and verifying. */
    testCases: z.array(z.union([TestCase, LegacyTestCase])).optional(),
    /** Where the task branch forked from the repo; verifying diffs against it. */
    baseCommit: z.string().nullable().optional(),
    /** For ci_watch: what the host fetched, since the sandbox has no gh credential. */
    ci: CiContext.nullable().optional(),
    /** For reviewing_memory: the last implementing run's slice ledger. */
    ledger: Ledger.nullable().optional(),
    /** For reviewing_memory: one row per earlier stage run of this task. */
    runs: z.array(RunSummary).optional(),
    /** For e2e: where QA runs, from the repo's luna.yaml. Credentials are references, never values. */
    qaTargets: z.array(QaTarget).optional(),
  }),
  limits: z.object({
    maxTurns: z.number().int(),
    timeoutMs: z.number().int(),
  }),
  env: z.record(z.string(), z.string()),
});
export type StageInput = z.infer<typeof StageInput>;

/** Schema 2 adds the `escalated` outcome; schema 3 adds the ledger and the session id. */
export const StageOutput = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  ok: z.boolean(),
  outcome: StageOutcome,
  summary: z.string(),
  /** The pack's structured output verbatim (triage criteria, test lists, verdicts). */
  answer: z.record(z.string(), z.unknown()).nullable().optional(),
  needsInput: z.array(NeedsInputItem).nullable(),
  requested: z.array(RequestedAction),
  findings: z.array(Finding),
  artifacts: z.array(StageArtifact),
  slices: z.object({ done: z.number().int(), total: z.number().int() }),
  commit: z.string().nullable(),
  usage: z.object({
    turns: z.number().int(),
    costUsd: z.number().nullable(),
    durationMs: z.number().int(),
    model: z.string(),
  }),
  /** The runner may pass the SDK's error object through verbatim. */
  error: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable(),
  rateLimited: z.boolean(),
  /** Epoch seconds, as the SDK reports them; older runners wrote a string. */
  resetsAt: z.union([z.number(), z.string()]).nullable(),
  /** Schema 3: the slice ledger the run left, so no host mount is needed to read it. */
  ledger: Ledger.nullable().optional(),
  /** Schema 3: the SDK session, resumable from the per-task session dir. */
  sessionId: z.string().nullable().optional(),
}).refine((output) => output.schema >= 2 || output.outcome !== "escalated", {
  message: "outcome escalated needs schema 2",
  path: ["outcome"],
});
export type StageOutput = z.infer<typeof StageOutput>;
