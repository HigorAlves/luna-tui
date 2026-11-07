// What a person's answer at the retro gate means for memory (RFC 0007, M2): which lessons are written (as written, or as edited),
// which items are retired, and the ground truth each answer is for the `memory_worth` and `memory_conflict` records. Pure.
//
// The answer is `response.lessons[]` on the approval (`LessonAnswer`): per lesson id `approve`, `edit` (with its new text) or `drop`;
// per retirement, the item's id with `approve` (retire it) or `drop` (keep it). With no `lessons` in the response (an older client, or
// a gate with none) nothing is written and nothing is retired, and no truth is kept. With a list, what it does not name is dropped.
import { type GateLesson, type GateRetirement, type LessonAnswer, LessonAnswer as LessonAnswerSchema, MEMORY_TEXT_MAX } from "@hardness/contracts";

import type { Label } from "./decision-truth.ts";

export interface ResolvedLessons {
  /** The lessons to write, with the text that was approved. */
  write: Array<{ lesson: GateLesson; text: string; edited: boolean }>;
  /** The items to retire: each contradicted by a lesson that is written. */
  retire: GateRetirement[];
  /** One ground truth per answered question. */
  truth: Array<{ pack: "memory_worth" | "memory_conflict"; recordId: string; label: Label; source: string }>;
}

const EMPTY: ResolvedLessons = { write: [], retire: [], truth: [] };

export function resolveLessons(gate: { lessons?: unknown; retirements?: unknown } | null | undefined, answered: unknown): ResolvedLessons {
  const lessons = Array.isArray(gate?.lessons) ? (gate!.lessons as GateLesson[]) : [];
  const retirements = Array.isArray(gate?.retirements) ? (gate!.retirements as GateRetirement[]) : [];
  if (!Array.isArray(answered)) return EMPTY;
  const answers = new Map<string, LessonAnswer>();
  for (const a of answered) {
    // An over-long edit is cut, not refused: the person's answer still counts.
    const text = (a as { text?: unknown } | null)?.text;
    const parsed = LessonAnswerSchema.safeParse(typeof text === "string" && a ? { ...(a as object), text: text.slice(0, MEMORY_TEXT_MAX) } : a);
    if (parsed.success) answers.set(parsed.data.id, parsed.data);
  }
  const out: ResolvedLessons = { write: [], retire: [], truth: [] };
  const written = new Set<string>();
  for (const lesson of lessons) {
    const a = answers.get(lesson.id);
    const action = a?.action ?? "drop";
    if (action === "drop") {
      if (lesson.record) out.truth.push({ pack: "memory_worth", recordId: lesson.record, label: { keep: { value: false } }, source: "lesson_dropped" });
      continue;
    }
    const edited = action === "edit" && typeof a?.text === "string" && a.text.trim() !== "";
    const text = (edited ? a!.text!.trim() : lesson.text).slice(0, MEMORY_TEXT_MAX);
    written.add(lesson.id);
    out.write.push({ lesson, text, edited });
    if (lesson.record) out.truth.push({ pack: "memory_worth", recordId: lesson.record, label: { keep: { value: true } }, source: edited ? "lesson_edited" : "lesson_approved" });
  }
  for (const r of retirements) {
    const approve = answers.get(r.itemId)?.action === "approve" || answers.get(r.itemId)?.action === "edit";
    // A retirement follows its lesson: the old item goes only when the lesson that contradicts it is kept.
    const retire = approve && written.has(r.lesson);
    if (retire) out.retire.push(r);
    if (r.record && r.slot) out.truth.push({ pack: "memory_conflict", recordId: r.record, label: { [`slot${r.slot}`]: { choice: retire ? "contradicts" : "consistent" } }, source: retire ? "retirement_approved" : "retirement_dropped" });
  }
  return out;
}
