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
const PROTECTED_LUNA: ReadonlySet<string> = new Set(["step", "slice_init", "slice_set", "slice_list", "decision_get", "scope_check", "scenario_red"]);

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

/** One thing the loop guard did in a run, as the machine keeps it (the `economy.guard` event's payload). */
export const EconomyGuardEvent = z.object({
  action: z.enum(["gate", "judge", "redirect", "stop"]),
  calls: z.number().int(),
  cause: z.string().optional(),
  failure: z.string().optional(),
});
export type EconomyGuardEvent = z.infer<typeof EconomyGuardEvent>;

/** A guard event with the run it happened in. */
export const GuardEventRow = EconomyGuardEvent.extend({ at: z.string(), runId: z.string(), pack: z.string() });
export type GuardEventRow = z.infer<typeof GuardEventRow>;

/** The line a prompt's learned-facts block opens with. The machine counts it in the block's size and the factory writes it, so both read it here. */
export const FACTS_HEADER = "# environment facts learned from earlier sessions in this repository";

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

/** What the economy knows about one repository: the envelopes, what the guard did lately, what it cost, the facts it learned. The mask and the proposal come with the slices that build them. */
export const EconomyStatus = z.object({
  envelopes: z.record(z.string(), z.object({ samples: z.number().int(), envelope: z.number().nullable() })),
  guard: z.array(GuardEventRow),
  cost: z.object({ exec: z.number(), overhead: z.number(), overheadShare: z.number() }),
  facts: z.array(FactStatus).optional(),
  mask: z.record(z.string(), z.unknown()).optional(),
  proposal: z.array(z.unknown()).optional(),
});
export type EconomyStatus = z.infer<typeof EconomyStatus>;
