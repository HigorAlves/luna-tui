// Why a Build escalated, as a typed decision with a confidence. Facts decide without a model (a second scope red; a service or container that
// never started); everything else, a spent budget included, goes to the `escalation_reason` decision once, with the machine's facts. Under the
// pack's bar the reason is `other` and a person reads it; a decision that cannot run leaves the agent's own word. Text from the agent and the
// failing output is data: flattened, cut and passed through `safe()` before it is sent or kept.
import { type DecisionOverrides, type EscalationReason } from "@hardness/contracts";
import { oneLine } from "@hardness/contracts";

import { safe } from "../../domain/evidence-markdown.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";

export type DecidedReason = Exclude<EscalationReason, "head_moved">;
export const DECIDED_REASONS = ["plan_wrong", "env_broken", "flaky_tests", "too_complex", "undeclared_scope", "other"] as const;
const DECIDED: readonly string[] = DECIDED_REASONS;
const isDecided = (value: unknown): value is DecidedReason => typeof value === "string" && DECIDED.includes(value);

export const TEXT_CAP = 500;
export const OUTPUT_CAP = 2000;
const MAX_FACTS = 8;

export interface EscalationInput {
  stage: string;
  /** What the stage said when it stopped. */
  summary: string;
  /** What the agent itself said: its reason, and its words. */
  agent?: { reason?: EscalationReason | null; text?: string };
  /** The tail of the last failing output. */
  output: string;
  facts: {
    /** A second scope red on the card. */
    scopeTwice?: boolean;
    /** A service that never became ready, or a container that could not start. */
    envBroken?: boolean;
    /** A spent budget: which limit, the numbers as text, and the reds in a row. */
    budget?: { spent: string; numbers: string; consecutiveReds: number };
    /** Other things the machine knows (the run cap, the stuck detector), one line each. */
    notes?: string[];
  };
  decide: Decide | null;
  repoPath: string | null;
  overrides: Record<string, DecisionOverrides>;
}

export interface DecidedEscalation {
  reason: DecidedReason;
  /** The decision's confidence; 1 for a fact, null where no decision answered. */
  confidence: number | null;
  source: "fact" | "decision" | "agent";
  /** The agent's own word, kept beside the decided one. */
  agentReason: EscalationReason | null;
  /** The decision record, for a person's correction to label. */
  recordId?: string;
  summary: string;
  outputTail: string;
  facts: string[];
}

const flat = (text: string | undefined): string => safe(oneLine(text ?? "", TEXT_CAP)).slice(0, TEXT_CAP);

export async function decideEscalation(input: EscalationInput): Promise<DecidedEscalation> {
  const agentReason = input.agent?.reason ?? null;
  const facts = [
    ...(input.facts.budget ? [`the budget is spent: ${input.facts.budget.numbers} (${input.facts.budget.spent})`, `${input.facts.budget.consecutiveReds} consecutive reds at the end of the ledger`] : []),
    ...(input.facts.scopeTwice ? ["the scope check failed twice on this card"] : []),
    ...(input.facts.envBroken ? ["a service or the container never started"] : []),
    ...(input.facts.notes ?? []),
  ].slice(0, MAX_FACTS).map((f) => flat(f));
  const summary = flat(input.summary);
  const outputTail = safe(input.output.slice(-OUTPUT_CAP)).slice(-OUTPUT_CAP);
  const kept = { agentReason, summary, outputTail, facts };
  if (input.facts.scopeTwice) return { reason: "undeclared_scope", confidence: 1, source: "fact", ...kept };
  if (input.facts.envBroken) return { reason: "env_broken", confidence: 1, source: "fact", ...kept };
  const word = flat(input.agent?.text);
  const { verdict, answer, recordId } = await judgeCheck(
    input.decide,
    "escalation_reason",
    { kind: "escalation", escalation: { stage: input.stage, summary, ...(agentReason ? { agentReason } : {}), ...(word ? { agentWord: word } : {}), output: outputTail, facts } },
    input.repoPath,
    input.overrides,
  );
  const picked = (answer?.reason as { choice?: unknown; confidence?: unknown } | undefined) ?? undefined;
  if (answer && isDecided(picked?.choice)) {
    const confidence = typeof picked.confidence === "number" ? picked.confidence : null;
    return { reason: verdict === "proceed" ? picked.choice : "other", confidence, source: "decision", ...(recordId ? { recordId } : {}), ...kept };
  }
  return { reason: isDecided(agentReason) ? agentReason : "other", confidence: null, source: "agent", ...kept };
}
