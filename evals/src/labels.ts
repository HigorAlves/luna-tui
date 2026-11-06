// A decision's label in one shape: per question, an object holding `choice`, `value` or `score`, as
// the answer does. A scalar is what the answer should have said; an array, what it may have said
// (a fact that only rules a label out). Pure helpers between labels, checks and answers.
import { type DecisionPack, PACKS, type PackId } from "@hardness/contracts";

import type { Check } from "./expect.ts";

export type Label = Record<string, Record<string, unknown>>;
const KEYS = ["choice", "value", "score"] as const;
const isScalar = (v: unknown): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v);

export const decisionPack = (pack: PackId): DecisionPack | null => (PACKS[pack].kind === "decision" ? (PACKS[pack] as DecisionPack) : null);

/** A label of unknown origin checked against the pack's own questions, as the command line's label is: every key a question of the pack, each entry
 *  one `choice` (a label of the question), `value` (a boolean) or `score` (a number within the rubric), nothing else. The clean label comes back. */
export function checkLabel(pack: PackId, label: unknown): { ok: true; label: Label } | { ok: false; reason: string } {
  const decision = decisionPack(pack);
  if (!decision) return { ok: false, reason: `${pack} is not a decision pack` };
  if (label === null || typeof label !== "object" || Array.isArray(label) || Object.keys(label).length === 0) return { ok: false, reason: "the label is empty or not an object" };
  const clean: Label = {};
  for (const [name, entry] of Object.entries(label)) {
    const question = decision.questions[name];
    if (!question) return { ok: false, reason: `${pack} has no question ${JSON.stringify(name).slice(0, 60)}` };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, reason: `${name}: not an object` };
    const keys = Object.keys(entry);
    const value = entry as Record<string, unknown>;
    if (question.type === "choice") {
      if (keys.length !== 1 || typeof value.choice !== "string" || !(value.choice in question.criteria)) return { ok: false, reason: `${name}: takes one of ${Object.keys(question.criteria).join(", ")}` };
      clean[name] = { choice: value.choice };
    } else if (question.type === "yesno") {
      if (keys.length !== 1 || typeof value.value !== "boolean") return { ok: false, reason: `${name}: takes true or false` };
      clean[name] = { value: value.value };
    } else {
      const levels = Object.keys(question.rubric).length;
      if (keys.length !== 1 || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > levels - 1) return { ok: false, reason: `${name}: takes a number from 0 to ${levels - 1}` };
      clean[name] = { score: value.score };
    }
  }
  return { ok: true, label: clean };
}

/** The checks a label asks of an answer: `equals` on a choice or a value, `oneOf` on an array, `between` ±0.5 on a score. */
export function checksOf(label: Label): Check[] {
  const checks: Check[] = [];
  for (const [question, entry] of Object.entries(label)) {
    for (const key of KEYS) {
      const wanted = entry[key];
      const path = `${question}.${key}`;
      if (Array.isArray(wanted) && wanted.length > 0 && wanted.every(isScalar)) checks.push({ kind: "oneOf", path, values: wanted });
      else if (key === "score" && typeof wanted === "number") checks.push({ kind: "between", path, min: wanted - 0.5, max: wanted + 0.5 });
      else if (isScalar(wanted) && wanted !== undefined) checks.push({ kind: "equals", path, value: wanted });
    }
  }
  return checks;
}

/** The label an answer is: its choice, value or score per question (confidence left out). */
export function labelOfAnswer(answer: Record<string, unknown>): Label {
  const label: Label = {};
  for (const [question, entry] of Object.entries(answer)) {
    if (entry === null || typeof entry !== "object") continue;
    const picked = Object.fromEntries(KEYS.flatMap((key) => (key in entry ? [[key, (entry as Record<string, unknown>)[key]]] : [])));
    if (Object.keys(picked).length > 0) label[question] = picked;
  }
  return label;
}

/** Whether an answer matches a label on every question the label names; null when it names none. */
export function matches(answer: Record<string, unknown>, label: Label): boolean | null {
  let any = false;
  for (const [question, entry] of Object.entries(label)) {
    for (const key of KEYS) {
      const wanted = entry[key];
      if (wanted === undefined) continue;
      any = true;
      const given = (answer[question] as Record<string, unknown> | undefined)?.[key];
      if (Array.isArray(wanted)) {
        if (!wanted.some((w) => w === given)) return false;
      } else if (key === "score" && typeof wanted === "number") {
        if (typeof given !== "number" || Math.abs(given - wanted) > 0.5) return false;
      } else if (given !== wanted) return false;
    }
  }
  return any ? true : null;
}

/** What the judge or a reader is told a good answer is: each question's own instructions. */
export function rubricOf(pack: DecisionPack, label: Label | null): string {
  const lines = Object.entries(pack.questions).map(([name, q]) => {
    const how = q.type === "choice" ? `${q.instructions ?? ""} Labels: ${Object.entries(q.criteria).map(([k, v]) => `${k} (${v})`).join("; ")}.` : q.instructions;
    return `${name}: ${how.trim()}`;
  });
  return `${lines.join("\n")}${label ? "" : "\n(Awaiting a label: a reviewer has not yet said what the right answer is.)"}`;
}
