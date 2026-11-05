// The engine each decision slot runs on by default, as data (RFC 0005 wave 7): `decision-defaults.json`
// is written by `pnpm eval defaults --write` from the scorecard over every baseline, with the reason
// and the date beside each. The machine never fails over a bad file: `decisionEngines` falls back to
// the built-in default for an entry it cannot trust, and `decision-defaults.test.ts` is what fails.
import { readFileSync } from "node:fs";

import { z } from "zod";

import { EngineId } from "./engines.ts";

/** The engines a decision pack may run on. A candidate outside this list never becomes a default. */
export const DECISION_ALLOWED = ["jev", "claude:haiku", "codex:luna"] as const satisfies readonly EngineId[];

/** What the engines were before anything was measured. */
export const BUILT_IN_DECISION_ENGINES = { default: "jev", allowed: [...DECISION_ALLOWED], fallback: ["claude:haiku"] } satisfies { default: EngineId; allowed: EngineId[]; fallback: EngineId[] };

/** One slot's entry: the default, its fallbacks, why, when it was measured, and the numbers behind it. */
export const DecisionDefault = z
  .object({
    default: z.enum(DECISION_ALLOWED),
    fallback: z.array(z.enum(DECISION_ALLOWED)),
    reason: z.string().min(1),
    measuredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scorecard: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((entry) => !entry.fallback.includes(entry.default), { message: "the fallback names the default" });
export type DecisionDefault = z.infer<typeof DecisionDefault>;

export const DecisionDefaults = z.record(z.string(), DecisionDefault);
/** The file as read at load: a missing or unparseable file is an empty one (one warning), so the machine boots on the built-in defaults; the contracts test is what fails. */
function readDefaults(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./decision-defaults.json", import.meta.url), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`decision-defaults.json unreadable, using the built-in defaults: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}
export const DECISION_DEFAULTS: Record<string, unknown> = readDefaults();

/** The engines of a decision pack: its entry in the defaults file when that is valid, else the built-in ones. `allowed` is fixed. */
export function decisionEngines(pack: string): { default: EngineId; allowed: EngineId[]; fallback: EngineId[] } {
  const entry = DecisionDefault.safeParse(DECISION_DEFAULTS[pack]);
  return entry.success ? { default: entry.data.default, allowed: [...DECISION_ALLOWED], fallback: entry.data.fallback } : { ...BUILT_IN_DECISION_ENGINES, allowed: [...DECISION_ALLOWED], fallback: [...BUILT_IN_DECISION_ENGINES.fallback] };
}
