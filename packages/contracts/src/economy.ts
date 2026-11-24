// The token economy's contract (RFC 0007): what a tool result is reduced to inside the container, what the machine hands the next run of a
// pack, how a run's tokens are priced, and how a mask narrows what a pack may use. The factory and the machine share it; neither imports the other.
import { z } from "zod";

import { type Access, type LunaTool } from "./access.ts";

/** What a runtime's own usage numbers mean as Build's token count: new work, never the model's text. A long session re-reads its context every turn,
 *  and counting those reads at full weight would spend a 2-million budget in one run, so the cache's reads are kept beside the count (`cached`) and
 *  off it. A runtime that gave no numbers gives null. */
export interface Tokens {
  /** New input: uncached input plus what was written to the cache (Claude), or input minus its cached part (eve). */
  input: number;
  output: number;
  /** Input read from the cache: kept beside the count, not part of it. */
  cached: number;
  /** The part of `input` written to the cache with the five-minute lifetime, when the runtime says. */
  cacheWrite5m?: number;
  /** The part of `input` written to the cache with the one-hour lifetime, when the runtime says. */
  cacheWrite1h?: number;
}

const TEST_LABEL = /^[A-Za-z_][\w.\-/]*(?:::[\w.\-[\]]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,59}$/;
const ENV_VALUE = /^[\w.\-/:]{1,60}$/;
/** A name that may hold a secret: the observer never reads its value, and a result that carries one is refused. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/** The class of one tool result, never its text: the output of a command can hold a secret, and the guard only needs to know what kind of call it was. Strict, so a field that carries text is refused. */
export const Observation = z
  .object({
    intent: z.enum(["test", "interpreter", "build", "package", "fetch", "vcs"]).optional(),
    /** The command with its arguments cut to a safe shape: a charset, a length. */
    form: z.string().max(120).optional(),
    errorClass: z.string().max(40).optional(),
    /** A hash of the error line with hex, digits and paths removed: two results of one failure agree. */
    failure: z.string().length(10).optional(),
    testsRan: z.boolean().optional(),
    /** The files a shell command wrote, as repo-relative paths. */
    edits: z.array(z.string().max(300)).max(20).optional(),
    /** A fetch's host, for the boundary family of facts. */
    host: z.string().max(120).optional(),
    /** The name of a missing or set variable. */
    envVar: z.string().max(60).optional(),
    /** The test labels a runner was given (a module, a path, a test id), and whether it failed to load one. */
    labels: z.array(z.string().max(120).regex(TEST_LABEL)).max(5).optional(),
    labelErr: z.boolean().optional(),
    /** The variables the output asked for. */
    needs: z.array(z.string().regex(ENV_NAME)).max(5).optional(),
    /** The values a command set, in a charset that cannot carry a sentence; never for a variable whose name looks like a credential. */
    sets: z.record(z.string().regex(ENV_NAME), z.string().regex(ENV_VALUE)).refine((v) => Object.keys(v).length <= 5 && !Object.keys(v).some((k) => CREDENTIAL_NAME.test(k)), "at most five variables, none named like a credential").optional(),
    /** A VCS probe's answer: it listed something (`hit`) or succeeded with nothing to list (`empty`). */
    probe: z.enum(["hit", "empty"]).optional(),
  })
  .strict();
export type Observation = z.infer<typeof Observation>;

/** What the loop guard needs in the container, from the machine. */
export const GuardInput = z.object({
  /** `record`: no envelope yet, or switched to shadow by missing samples. The guard only writes its gate events. */
  mode: z.enum(["on", "record"]),
  /** The pack has shell access, so a judge can be asked. */
  judge: z.boolean(),
  /** Calls a passing run of this pack usually takes, or null before there are enough runs. */
  envelope: z.number().nullable(),
  judgeConfidence: z.number(),
  redirects: z.number().int(),
  backstopMult: z.number(),
});
export type GuardInput = z.infer<typeof GuardInput>;

/** What a person approved removing from a pack: a listed unit is removed, nothing is ever added. */
export const ToolMask = z.object({ web: z.boolean().optional(), agent: z.boolean().optional(), skills: z.array(z.string()).optional(), luna: z.array(z.string()).optional() });
export type ToolMask = z.infer<typeof ToolMask>;

/** `StageInput.context.economy`: the guard, the learned facts and the manual (each rendered as declared data), and the approved mask. */
export const EconomyInput = z.object({
  guard: GuardInput.optional(),
  facts: z.array(z.string().max(240)).max(8).optional(),
  manual: z.array(z.string().max(240)).max(8).optional(),
  mask: ToolMask.optional(),
});
export type EconomyInput = z.infer<typeof EconomyInput>;

/** The `economy` section of `luna.yaml`, with its defaults applied. */
export interface EconomyConfig {
  loop_guard: "on" | "off";
  facts: "on" | "free" | "off";
  tool_prune: "propose" | "off";
  propose_every: number;
  promote_cards: number;
  guard: { judge_confidence: number; redirects: number; backstop_mult: number; envelope_min_samples: number };
  prune: { runs: number; min_cards: number; cards: number };
}

/** What a stage's usage may carry of a run's tokens: `cached` may be missing from older numbers. */
export type TokensIn = Pick<Tokens, "input" | "output"> & Partial<Tokens>;

/** Two runs' tokens added, every field kept: the cache writes are summed when either run has them. A side that is null or absent gives the other. */
export function sumTokens(a: TokensIn | null | undefined, b: TokensIn | null | undefined): Tokens | null {
  if (!a && !b) return null;
  const x = a ?? { input: 0, output: 0 };
  const y = b ?? { input: 0, output: 0 };
  const total: Tokens = { input: x.input + y.input, output: x.output + y.output, cached: (x.cached ?? 0) + (y.cached ?? 0) };
  if (x.cacheWrite5m !== undefined || y.cacheWrite5m !== undefined) total.cacheWrite5m = (x.cacheWrite5m ?? 0) + (y.cacheWrite5m ?? 0);
  if (x.cacheWrite1h !== undefined || y.cacheWrite1h !== undefined) total.cacheWrite1h = (x.cacheWrite1h ?? 0) + (y.cacheWrite1h ?? 0);
  return total;
}

/** The price of each kind of token, relative to a fresh input token (the providers' published ratios). */
export const EFFECTIVE_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 } as const;

/** A run's cost as it is billed, in input-token units. `input` holds the cache writes, so they come off it before they are weighted. */
export function effectiveTokens(t: Tokens): number {
  const write5m = t.cacheWrite5m ?? 0;
  const write1h = t.cacheWrite1h ?? 0;
  const fresh = Math.max(0, t.input - write5m - write1h);
  return fresh * EFFECTIVE_WEIGHTS.input + t.cached * EFFECTIVE_WEIGHTS.cacheRead + write5m * EFFECTIVE_WEIGHTS.cacheWrite5m + write1h * EFFECTIVE_WEIGHTS.cacheWrite1h + t.output * EFFECTIVE_WEIGHTS.output;
}

/** The luna tools the machine relies on: the progress, the slice ledger, the settled decisions, the scope check and the scenario gate. A mask never removes one. */
export const PROTECTED_LUNA: ReadonlySet<string> = new Set(["step", "slice_init", "slice_set", "slice_list", "decision_get", "scope_check", "scenario_red"]);

/** `access` and the pack's skills with the units of `mask` removed. It only removes: a protected luna tool stays, and when every skill is masked the skills switch turns off. */
export function narrow(access: Access, mask: ToolMask | undefined, packSkills: string[]): { access: Access; skills: string[] } {
  if (!mask) return { access, skills: packSkills };
  const skills = packSkills.filter((name) => !mask.skills?.includes(name));
  const gone = new Set(mask.luna?.filter((name) => !PROTECTED_LUNA.has(name)));
  return {
    access: {
      ...access,
      web: mask.web ? false : access.web,
      agent: mask.agent ? false : access.agent,
      skills: access.skills && !(packSkills.length > 0 && skills.length === 0),
      luna: access.luna.filter((name: LunaTool) => !gone.has(name)),
    },
    skills,
  };
}

/** What a run that the loop guard stopped says first in `StageOutput.error`, as `BUDGET_SPENT` does for the budget. */
export const LOOP_STUCK = "the loop guard stopped the run";

/** One thing the loop guard did in a run, as the machine keeps it (the `economy.guard` event's payload). The container writes it, so each field is bounded: a cause is the guard's own word (`backstop`, `repeat`, `errors`) or the judge's choice label, a failure the observer's ten-digit fingerprint. */
export const EconomyGuardEvent = z.object({
  action: z.enum(["gate", "judge", "redirect", "stop"]),
  calls: z.number().int().min(0).max(1_000_000),
  cause: z.string().max(60).regex(/^[a-z0-9_ ,.:-]*$/i).optional(),
  failure: z.string().regex(/^[0-9a-f]{10}$/).optional(),
});
export type EconomyGuardEvent = z.infer<typeof EconomyGuardEvent>;

/** A guard event with the run it happened in. */
export const GuardEventRow = EconomyGuardEvent.extend({ at: z.string(), runId: z.string(), pack: z.string() });
export type GuardEventRow = z.infer<typeof GuardEventRow>;

/** The line a prompt's learned-facts block opens with. The machine counts it in the block's size and the factory writes it, so both read it here. */
export const FACTS_HEADER = "# environment facts learned from earlier sessions in this repository";

/** The line a prompt's manual block opens with: the facts the proposer found and three runs confirmed. The repository is named by the base name of its path, cut to a safe charset, so a folder name cannot end the line or the block. */
export const manualHeader = (repoPath: string): string => `# repo operating manual (${repoName(repoPath)}) — learned from earlier sessions in this repository`;

/** A repository's folder name, cut to `[A-Za-z0-9._-]` (at most 120 characters); `repo` when nothing is left. */
export function repoName(repoPath: string): string {
  const name = (repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 120);
  return name === "" ? "repo" : name;
}

/** The sections of `docs/agents/project-context.md`, in the order the file keeps them. */
export const PROJECT_CONTEXT_SECTIONS = ["Stack & versions", "Commands", "Critical rules", "Patterns to follow", "Patterns to avoid", "Known landmines"] as const;
export const ProjectContextSection = z.enum(PROJECT_CONTEXT_SECTIONS);
export type ProjectContextSection = z.infer<typeof ProjectContextSection>;

/** The classes of environment error the observer names (`Observation.errorClass`). */
export const ERROR_CLASSES = ["module_missing", "command_missing", "script_missing", "permission_denied", "usage_error", "connection_refused", "name_resolution", "unreachable"] as const;

/** What a run's observed calls can say, as the proposer's detectors name it. Each is decided by the machine over the run's calls; none runs a pattern. */
export const DETECTOR_PREDICATES = ["ran_tests", "tests_passed", "tests_failed", "ran_checks", "ran_build", "edited", "command_failed", "missing_command", "missing_dependency", "bad_usage"] as const;

/** A literal of a command's spelling: letters, digits, space and `. _ - / : = @`, so it can never be read as a pattern or break a line. */
const COMMAND_LITERAL = /^[A-Za-z0-9 ._\-/:=@]{2,80}$/;

/** One thing a run's calls either show or do not. Strict: a field that is not one of these is refused. */
export const DetectorAtom = z.union([
  z.object({ predicate: z.enum(DETECTOR_PREDICATES) }).strict(),
  z.object({ commandIncludes: z.string().regex(COMMAND_LITERAL) }).strict(),
  z.object({ errorClass: z.enum(ERROR_CLASSES) }).strict(),
  z.object({ intent: Observation.shape.intent.unwrap() }).strict(),
]);
export type DetectorAtom = z.infer<typeof DetectorAtom>;

/** Holds on a run when every atom does. */
export const DetectorClause = z.object({ all: z.array(DetectorAtom).min(1).max(4) }).strict();
export type DetectorClause = z.infer<typeof DetectorClause>;

/** How a proposed fact is checked on a run, with no model: `scope` says the fact is about this run, `confirm` that it held, `contradict` that it did not. */
export const Detector = z.object({ scope: DetectorClause, confirm: DetectorClause, contradict: DetectorClause }).strict();
export type Detector = z.infer<typeof Detector>;

/** One run as the proposer reads it (the machine's digest of the run's observed calls). */
export const ProposeDigest = z.object({
  at: z.string().max(40),
  runId: z.string().max(100),
  pack: z.string().max(60),
  cardId: z.string().max(100),
  outcome: z.string().max(40),
  calls: z.number().int().nonnegative(),
  lines: z.array(z.string().max(300)).max(40),
});
export type ProposeDigest = z.infer<typeof ProposeDigest>;

/** `StageInput.context.propose` for fact_propose: the repository's name, its last runs and the texts of the facts it already holds. All data. */
export const ProposeContext = z.object({
  repo: z.string().max(120),
  digests: z.array(ProposeDigest).max(8),
  known: z.array(z.string().max(240)).max(20),
});
export type ProposeContext = z.infer<typeof ProposeContext>;

/** fact_propose: up to four facts, each one line grounded in at least two of the runs it was shown. The machine admits one only when its detector confirms on those runs. */
export const FactProposal = z.object({
  facts: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        section: ProjectContextSection,
        detector: Detector,
        cites: z.array(z.string().max(100)).min(2).max(4),
      }),
    )
    .max(4),
});
export type FactProposal = z.infer<typeof FactProposal>;

/** One learned fact as the status shows it: where it came from, how far it got, what the next run is told. */
export const FactStatus = z.object({
  id: z.string(),
  family: z.string(),
  source: z.enum(["free", "proposed"]),
  state: z.enum(["candidate", "active", "retired", "dropped", "promoted"]),
  text: z.string(),
  confirmations: z.number().int(),
  contradictions: z.number().int(),
  /** Runs that used what the fact is about, and the part of them in which it applied. */
  exercised: z.number().int(),
  fired: z.number().int(),
});
export type FactStatus = z.infer<typeof FactStatus>;

/** A unit proposed for removal (`web`, `agent`, `skill:<name>`, `luna:<tool>`) and what shows it is unused: the runs and the distinct cards it went unused over. */
export const ToolProposal = z.object({ unit: z.string(), unusedRuns: z.number().int(), cards: z.number().int() });
export type ToolProposal = z.infer<typeof ToolProposal>;

/** One pack's tool pruning in a repository: the applied mask (units) and the proposal waiting for a person. */
export const ToolsStatus = z.object({ mask: z.array(z.string()), proposal: z.array(ToolProposal) });
export type ToolsStatus = z.infer<typeof ToolsStatus>;

/** What the economy knows about one repository: the envelopes, what the guard did lately, what it cost, the facts it learned, the tools it proposes removing. */
export const EconomyStatus = z.object({
  envelopes: z.record(z.string(), z.object({ samples: z.number().int(), envelope: z.number().nullable() })),
  guard: z.array(GuardEventRow),
  /** What the work and the economy's own runs cost, in effective tokens; `overheadUnpriced` counts the overhead runs that reported no tokens, so `overhead` is a floor when it is above 0. */
  cost: z.object({ exec: z.number(), overhead: z.number(), overheadShare: z.number(), overheadUnpriced: z.number().int() }),
  facts: z.array(FactStatus).optional(),
  /** Per pack: the units a person approved removing, and the ones proposed, with their evidence. */
  tools: z.record(z.string(), ToolsStatus).optional(),
});
export type EconomyStatus = z.infer<typeof EconomyStatus>;
