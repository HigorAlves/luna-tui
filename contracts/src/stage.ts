// The stage contract between the machine and orc's stage packs: the machine writes
// `/in/stage.json` (StageInput) and reads `/out/result.json` (StageOutput). The shapes are
// frozen by the orc plan; orc validates the same JSON against its own schemas.
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
  /** orc's schema allows null when the stage has no default to offer. */
  recommended: z.string().nullable(),
});
export type NeedsInputItem = z.infer<typeof NeedsInputItem>;

/** A hard-outward action orc refused to run inside the sandbox; the board approves it. */
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

/** One review finding, as in orc:review-contract. */
export const Finding = z.object({
  path: z.string(),
  line: z.number().int(),
  // orc's pack schemas require path/line/severity/title/body/confidence only; the rest is
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

/** Schema 2's shape, read for images built before the schema 3 rename. */
const LegacyTestCase = z.object({
  title: z.string(),
  criterion: z.string().nullable(),
  test: z.string(),
});

/** One scenario verifying proved (or didn't), alongside its code review. */
export const VerifyResult = TestCase.extend({ outcome: z.enum(["pass", "fail"]) });
export type VerifyResult = z.infer<typeof VerifyResult>;

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
    tests: z.array(z.string()),
    /** The cases approved at the test check, for implementing and verifying. */
    testCases: z.array(z.union([TestCase, LegacyTestCase])).optional(),
  }),
  limits: z.object({
    maxTurns: z.number().int(),
    timeoutMs: z.number().int(),
  }),
  env: z.record(z.string(), z.string()),
});
export type StageInput = z.infer<typeof StageInput>;

/** Schema 2 adds the `escalated` outcome; orc builds before it still write schema 1. */
export const StageOutput = z.object({
  schema: z.union([z.literal(1), z.literal(2)]),
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
  /** orc may pass the SDK's error object through verbatim. */
  error: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable(),
  rateLimited: z.boolean(),
  /** Epoch seconds. run.mjs writes it as a string (`String(info.resetsAt)`). */
  resetsAt: z.union([z.number(), z.string()]).nullable(),
}).refine((output) => output.schema === 2 || output.outcome !== "escalated", {
  message: "outcome escalated needs schema 2",
  path: ["outcome"],
});
export type StageOutput = z.infer<typeof StageOutput>;
