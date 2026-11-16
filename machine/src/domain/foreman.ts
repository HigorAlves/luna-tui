// The foreman's view of the board: the open cards, as the model reads them. Pure.
// Every text on a card is a person's or a model's, so it is trimmed here and treated as data downstream.
import { type EngineId, type ForemanCard, type ForemanContext, type PackId, columnOf, isTerminal } from "@hardness/contracts";
import { basename } from "node:path";

import type { TaskRow } from "./task.ts";

export const FOREMAN_MAX_CARDS = 60;
const TITLE_MAX = 120;
const SUMMARY_MAX = 200;

/** A card's open approval: the gate it waits at and what the machine asked there. */
export interface OpenGate {
  /** The approval's id. */
  id?: string;
  state: string;
  requested: Record<string, unknown>;
}

const flat = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

function questionsOf(gate: OpenGate | undefined): ForemanCard["questions"] {
  const asked = gate?.state === "awaiting_answers" && Array.isArray(gate.requested.questions) ? (gate.requested.questions as Array<{ question?: unknown; recommended?: unknown }>) : [];
  const out: ForemanCard["questions"] = [];
  for (const q of asked) {
    if (typeof q?.question !== "string") continue;
    out.push({ id: `q${out.length + 1}`, question: q.question, recommended: typeof q.recommended === "string" ? q.recommended : null });
  }
  return out;
}

function summaryOf(gate: OpenGate | undefined, questions: number): string | null {
  if (!gate) return null;
  if (questions > 0) return `${questions} open question${questions === 1 ? "" : "s"}`;
  const text = [gate.requested.summary, gate.requested.reason].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return text === undefined ? null : flat(text, SUMMARY_MAX);
}

/** What the open gate decides beyond the plan: triage's outcome, or the release question. */
function outcomeOf(gate: OpenGate | undefined): string | null {
  if (!gate) return null;
  if (typeof gate.requested.outcome === "string") return gate.requested.outcome;
  return gate.requested.gate === "ship_approval" ? "ship_approval" : null;
}

export function buildForemanBoard(
  tasks: readonly TaskRow[],
  gates: ReadonlyMap<string, OpenGate>,
  packs: ReadonlyArray<{ id: PackId; engines: { allowed: readonly EngineId[] } }>,
  now: Date,
): ForemanContext["board"] {
  // A card that waits on a person comes first, the oldest wait first; the rest follow, newest first. The cut then drops the quiet cards.
  const waits = (t: TaskRow): boolean => t.state === "escalated" || t.state === "awaiting_answers" || gates.has(t.id);
  const open = tasks
    .filter((t) => !isTerminal(t.state))
    .sort((a, b) => {
      const [wa, wb] = [waits(a), waits(b)];
      if (wa !== wb) return wa ? -1 : 1;
      return wa ? a.updatedAt.getTime() - b.updatedAt.getTime() : b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  const cards = open
    .slice(0, FOREMAN_MAX_CARDS)
    .map((t): ForemanCard => {
      const gate = gates.get(t.id);
      const questions = questionsOf(gate);
      return {
        id: t.id,
        title: flat(t.title, TITLE_MAX),
        repo: t.repoPath ? basename(t.repoPath) : "",
        state: t.state,
        column: columnOf(t.state, t.resumeTo),
        gate: gate?.state ?? null,
        gateSummary: summaryOf(gate, questions.length),
        gateOutcome: outcomeOf(gate),
        approvalId: gate?.id ?? null,
        route: t.route,
        escalation: t.state === "escalated" ? (t.reason ?? "escalated") : null,
        questions,
        engines: t.stages ?? {},
        updatedAt: t.updatedAt.toISOString(),
      };
    });
  return { now: now.toISOString(), cards, truncated: open.length - cards.length, packs: packs.map((p) => ({ id: p.id, allowed: [...p.engines.allowed] })) };
}
