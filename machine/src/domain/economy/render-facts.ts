// The facts a run is told (te-spec 2.2.5): the active free facts that keep applying, at most four lines and 600 characters with the header's
// share counted, ordered as upstream orders them. A line that reads as completion or verification advice, or that is shaped like a secret,
// is refused whatever its source. A line is kept whole or left out; it is never cut.
import { FACTS_HEADER } from "@hardness/contracts";

import { findingKinds } from "../../../runner-video/tools/lib/findings.ts";
import type { Family } from "./envfacts.ts";
import { type FactRecord, fires } from "./lifecycle.ts";

export const MAX_FACTS = 4;
/** About four characters a token; the whole block, header included. */
export const MAX_TOKENS = 150;
/** The most one line may hold: what a stage input accepts for a fact. */
const MAX_LINE = 240;

// Words that would turn a fact into advice about being done or about checking.
const LINT = /\b(skip|no need|don'?t|do not|stop|done|completed?|finish(?:ed)?|verify|verification|instead of (?:running|testing))\b/i;
export const lintOk = (text: string): boolean => !LINT.test(text);

const PRIORITY: Record<Family, number> = { form_repair: 0, arg_repair: 1, env_value: 2, absent_tool: 3, empty_probe: 4, boundary: 5 };

const sayable = (fact: FactRecord): boolean => fact.text !== "" && fact.text.length <= MAX_LINE && !/[\r\n]/.test(fact.text) && lintOk(fact.text) && findingKinds(fact.text).length === 0;
const rate = (fact: FactRecord): number => (fact.exercised === 0 ? 0 : fact.fired / fact.exercised);

/** The facts the next run is told, in the order their lines appear. */
export function selectInjected(facts: readonly FactRecord[]): FactRecord[] {
  const candidates = facts
    .filter((f) => fires(f) && sayable(f))
    .sort((a, b) => PRIORITY[a.family] - PRIORITY[b.family] || Number(b.key.startsWith("interpreter:")) - Number(a.key.startsWith("interpreter:")) || rate(b) - rate(a));
  const chosen: FactRecord[] = [];
  for (const fact of candidates) {
    if (chosen.length + 1 > MAX_FACTS) break;
    const block = `${FACTS_HEADER}\n${[...chosen, fact].map((f) => `- ${f.text}`).join("\n")}`;
    if (block.length > MAX_TOKENS * 4) continue;
    chosen.push(fact);
  }
  return chosen;
}

/** The lines of the facts the next run is told, without the header and the bullets: the factory writes those. */
export const injected = (facts: readonly FactRecord[]): string[] => selectInjected(facts).map((f) => f.text);
