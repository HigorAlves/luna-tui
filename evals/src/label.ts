// A person labels a record on this computer: `pnpm eval label`. The value is checked against the question's own labels, the truth is a `person` truth
// that outranks a fact and an outcome, and nothing leaves the machine. `next` shows the oldest record with no person label, as text a terminal cannot be painted by.
import type { DecisionPack, DecisionRecord, DecisionTruth, PackId } from "@hardness/contracts";

import { decisionPack, type Label } from "./labels.ts";
import { maskPii } from "@hardness/machine/decisions";

import { labelState, printable, stripUnsafe } from "./records.ts";

const CONTEXT_CAP = 4000;

const allowedOf = (question: DecisionPack["questions"][string]): string[] => (question.type === "choice" ? Object.keys(question.criteria) : question.type === "yesno" ? ["true", "false"] : [`a number from 0 to ${Object.keys(question.rubric).length - 1}`]);

export type LabelResult = { ok: true; label: Label } | { ok: false; reason: string };

/** `question=value` pairs as a label: a choice's criteria key, `true` or `false`, a rubric level by number. Anything else is refused with what is allowed. */
export function labelFor(pack: PackId, sets: string[]): LabelResult {
  const decision = decisionPack(pack);
  if (!decision) return { ok: false, reason: `${pack} is not a decision pack` };
  if (sets.length === 0) return { ok: false, reason: `give at least one --set <question>=<value>; questions: ${Object.keys(decision.questions).join(", ")}` };
  const label: Label = {};
  for (const set of sets) {
    const at = set.indexOf("=");
    const name = at > 0 ? set.slice(0, at) : "";
    const value = at > 0 ? set.slice(at + 1) : "";
    const question = decision.questions[name];
    if (!question) return { ok: false, reason: `${set}: ${pack} has no question ${name || "(none given)"}; questions: ${Object.keys(decision.questions).join(", ")}` };
    if (question.type === "choice") {
      if (!(value in question.criteria)) return { ok: false, reason: `${set}: ${name} takes one of ${allowedOf(question).join(", ")}` };
      label[name] = { choice: value };
    } else if (question.type === "yesno") {
      if (value !== "true" && value !== "false") return { ok: false, reason: `${set}: ${name} takes ${allowedOf(question).join(", ")}` };
      label[name] = { value: value === "true" };
    } else {
      const levels = Object.keys(question.rubric).length;
      const score = Number(value);
      if (value.trim() === "" || !Number.isFinite(score) || score < 0 || score > levels - 1) return { ok: false, reason: `${set}: ${name} takes ${allowedOf(question).join(", ")}` };
      label[name] = { score };
    }
  }
  return { ok: true, label };
}

export interface LabelTarget {
  read(pack: PackId, id: string): Promise<DecisionRecord | null>;
  setTruth(pack: PackId, id: string, truth: DecisionTruth): Promise<boolean>;
}

/** Writes the person's truth on the record. The note passes the printable filter (control characters out, token shapes redacted) before it is kept. */
export async function setLabel(log: LabelTarget, pack: PackId, id: string, sets: string[], note: string | undefined, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const made = labelFor(pack, sets);
  if (!made.ok) return made;
  if (!(await log.read(pack, id))) return { ok: false, reason: `no ${pack} record ${id} on this computer` };
  const kept = note ? printable(note).slice(0, 500) : "";
  const wrote = await log.setTruth(pack, id, { label: made.label, source: "person_cli", kind: "person", at: now.toISOString(), ...(kept ? { note: kept } : {}) });
  return wrote ? { ok: true } : { ok: false, reason: `the record ${id} could not be written` };
}

const hasPersonLabel = (record: DecisionRecord): boolean => record.truth?.kind === "person" || (record.truth?.history ?? []).some((entry) => entry.kind === "person") || Object.values(record.truth?.kinds ?? {}).includes("person");

/** The oldest record with no person truth, given records oldest first or not. */
export function nextToLabel(records: DecisionRecord[]): DecisionRecord | null {
  return [...records].filter((r) => !hasPersonLabel(r) && labelState(r) !== "not_labelable").sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
}

const flat = (value: unknown, path = ""): string[] =>
  typeof value === "string" ? [`${path}: ${value}`]
  : Array.isArray(value) ? value.flatMap((item, i) => flat(item, `${path}[${i}]`))
  : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => flat(item, path ? `${path}.${key}` : key))
  : value === undefined || value === null ? [] : [`${path}: ${String(value)}`];

/** What a person needs to label one record: the stored context flattened and capped at 4,000 characters, the model's answer, each question's labels, the command to type. */
export function renderNext(record: DecisionRecord): string[] {
  const decision = decisionPack(record.pack)!;
  const priv = record.private === true || (record.context as { conversation?: { private?: unknown } }).conversation?.private === true;
  const context = priv ? "(private conversation: its text is not shown, and was never kept; label it from what you remember of the thread)" : maskPii(printable(flat(record.context).join("\n"))).slice(0, CONTEXT_CAP);
  const lines = [`${record.pack}  ${record.id}  ${record.at}  ${record.engine}`, "", "context:", context, "", "the model said:"];
  for (const [name, entry] of Object.entries(record.answer)) lines.push(maskPii(printable(`  ${name}: ${JSON.stringify(entry)}`)));
  lines.push("", "labels:");
  for (const [name, question] of Object.entries(decision.questions)) lines.push(`  ${name}: ${allowedOf(question).join(", ")}`);
  const first = Object.keys(decision.questions)[0]!;
  lines.push("", `pnpm eval label --pack ${record.pack} --record ${record.id} --set ${first}=<label> [--set ...] [--note <text>]`);
  return lines.map(stripUnsafe);
}
