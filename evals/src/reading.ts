// The reading behind a hand-written case's label, checked against the pack's own words. A label is tied to the criterion text as the pack words it,
// so a criterion that changes later breaks the case until it is read again. Pure.
import { type DecisionPack, PACKS, type PackId } from "@hardness/contracts";

import type { Expect } from "./expect.ts";
import { type Label, decisionPack } from "./labels.ts";

export interface CaseView {
  id: string;
  expect: Expect;
  stage: unknown;
}

/** How many questions a labelled case of a per-answer pack must label, from the plan's table. */
export const MIN_LABELLED_QUESTIONS: Partial<Record<PackId, number>> = { triage_signals: 8, ticket_assess: 10, conversation_assess: 6 };

/** Longest question set whose other labels a reading must rule out one by one. */
const RULE_OUT_MAX = 6;
const REASON_MIN = 20;
const BOUND_MAX = 0.85;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const textOf = (question: DecisionPack["questions"][string], value: unknown): string | null => {
  if (question.type === "choice") return typeof value === "string" && value in question.criteria ? question.criteria[value]! : null;
  if (question.type === "score") {
    const levels = Object.values(question.rubric);
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < levels.length ? levels[value]! : null;
  }
  return null;
};

/** The pack's own text for what a label says on one question: a choice's criterion (several joined by " | " for a list of acceptable labels), a yes/no's instructions, a score level's rubric text. Null when the label is not one of the question's. */
export function criterionOf(pack: PackId, question: string, entry: Record<string, unknown>): string | null {
  const decision = decisionPack(pack);
  const q = decision?.questions[question];
  if (!q) return null;
  if (q.type === "yesno") return typeof entry.value === "boolean" ? q.instructions : null;
  const wanted = q.type === "choice" ? entry.choice : entry.score;
  const values = Array.isArray(wanted) ? wanted : [wanted];
  const texts = values.map((v) => textOf(q, v));
  return texts.length > 0 && texts.every((t): t is string => t !== null) ? texts.join(" | ") : null;
}

function tieProblems(pack: PackId, label: Label, criteria: Record<string, string>, where: string): string[] {
  const problems: string[] = [];
  for (const [question, entry] of Object.entries(label)) {
    if (!(question in (decisionPack(pack)?.questions ?? {}))) {
      problems.push(`${where}: ${question} is not a question of ${pack}`);
      continue;
    }
    const wanted = criterionOf(pack, question, entry);
    if (wanted === null) problems.push(`${where}: ${question} ${JSON.stringify(entry)} is not one of the question's labels`);
    else if (criteria[question] !== wanted) problems.push(`${where}: reading.criteria.${question} is not the pack's own criterion text for ${JSON.stringify(entry)} (it must read: ${JSON.stringify(wanted)})`);
  }
  return problems;
}

/** The problems of one hand-written case: empty when its reading holds. `others` are the pack's other cases (for a twin). */
export function checkReading(pack: PackId, _id: string, expect: Expect, stage: unknown, others: CaseView[]): string[] {
  const decision = decisionPack(pack);
  if (!decision) return [`${pack} is not a decision pack`];
  const problems: string[] = [];
  const { label, kind, reading } = expect;

  if (!label) {
    if (kind !== "borderline") return [`a case with no label is a borderline one: set kind "borderline" (and give it two readings)`];
    if (!reading) return ["a borderline case needs a reading"];
    const readings = reading.readings ?? [];
    if (readings.length < 2) problems.push("a borderline case has at least two readings, or it is not borderline");
    for (const [i, r] of readings.entries()) problems.push(...tieProblems(pack, r.label, r.criteria, `readings[${i}]`));
    if (readings.length >= 2 && new Set(readings.map((r) => JSON.stringify(r.label))).size < 2) problems.push("the readings of a borderline case must give different labels");
    const bounded = expect.checks.some((c) => c.kind === "between" && /\.(p|confidence)$/.test(c.path) && c.max !== undefined && c.max <= BOUND_MAX);
    if (!bounded) problems.push(`a borderline case checks the confidence: a between check on a .p or .confidence path with a max of ${BOUND_MAX} or less`);
    return problems;
  }

  if (kind === "borderline") return ["a borderline case has no label: it has two readings and checks the confidence"];
  if (kind !== "labelled" && kind !== "adversarial") problems.push(`a case with a label has kind "labelled" or "adversarial" (it has ${JSON.stringify(kind ?? null)})`);
  if (!reading) return [...problems, "a case with a label needs a reading"];
  problems.push(...tieProblems(pack, label, reading.criteria, "label"));
  for (const [question, entry] of Object.entries(label)) {
    const q = decision.questions[question];
    if (q?.type !== "choice" || Array.isArray(entry.choice) || Object.keys(q.criteria).length > RULE_OUT_MAX) continue;
    for (const other of Object.keys(q.criteria).filter((k) => k !== entry.choice)) {
      const why = reading.ruledOut?.find((r) => r.question === question && r.label === other)?.why ?? "";
      if (why.length < REASON_MIN) problems.push(`ruled out: ${question} needs a reason of at least ${REASON_MIN} characters for why not ${other}`);
    }
  }
  if (!same(reading.second.label, label) || reading.second.agrees !== true) problems.push("the second reading must give the same label and agree");

  const minimum = MIN_LABELLED_QUESTIONS[pack];
  if (minimum !== undefined && Object.keys(label).length < minimum) problems.push(`a labelled case of ${pack} labels at least ${minimum} questions (it labels ${Object.keys(label).length})`);

  if (kind === "adversarial") {
    const twin = expect.twin ? others.find((o) => o.id === expect.twin) : undefined;
    if (!expect.twin) problems.push("an adversarial case names its twin");
    else if (!twin) problems.push(`the twin ${expect.twin} is not a case of ${pack}`);
    else {
      if (twin.expect.kind !== "labelled") problems.push(`the twin ${twin.id} must be a labelled case`);
      if (!same(twin.expect.label, label)) problems.push(`the twin ${twin.id} has a different label: the case is ambiguous apart from its steering text`);
      if (same(twin.stage, stage)) problems.push(`the twin ${twin.id}'s input must differ from this one (it is the same input without the steering text)`);
    }
  }
  return problems;
}
