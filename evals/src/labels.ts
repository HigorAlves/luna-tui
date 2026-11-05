// A decision's label in one shape: per question, an object holding `choice`, `value` or `score`, as
// the answer does. A scalar is what the answer should have said; an array, what it may have said
// (a fact that only rules a label out). Pure helpers between labels, checks and answers.
import { type DecisionPack, PACKS, type PackId } from "@hardness/contracts";

import type { Check } from "./expect.ts";

export type Label = Record<string, Record<string, unknown>>;
const KEYS = ["choice", "value", "score"] as const;
const isScalar = (v: unknown): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v);

export const decisionPack = (pack: PackId): DecisionPack | null => (PACKS[pack].kind === "decision" ? (PACKS[pack] as DecisionPack) : null);

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
