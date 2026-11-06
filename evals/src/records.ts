// Where each decision record stands for the ground-truth loop, and the report of a card's decisions.
// A label is a person's act: nothing here sends anything anywhere. Pure, except `priorityHints`, which reads the state dir.
import { type DecisionRecord, type TruthKind } from "@hardness/contracts";
import { redact, safe } from "@hardness/machine/decisions";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { scrubContext } from "./scrub.ts";

export type LabelState = "labelled" | "to_confirm" | "queue" | "local_only" | "not_labelable";

/** The kind each question's label has: the latest history entry that names it, else the truth's own kind (no kind reads as a fact). */
function kindsOf(truth: NonNullable<DecisionRecord["truth"]>): Map<string, TruthKind> {
  const kinds = new Map<string, TruthKind>();
  for (const question of Object.keys(truth.label)) kinds.set(question, truth.kind ?? "fact");
  for (const entry of truth.history ?? []) for (const question of Object.keys(entry.label)) kinds.set(question, entry.kind);
  return kinds;
}

/** Exactly one state per record. `labelled`: a person or a fact labels every question the answer holds. `to_confirm`: a truth exists but some answered
 *  question has only an outcome or no label. `queue`: no truth and the scrub accepts the context. `local_only`: no truth, and the scrub refuses it or it is private,
 *  so it can be labelled on this computer and nowhere else. `not_labelable`: no truth and no context (the repository chose `learning.context: answers`). */
export function labelState(record: DecisionRecord): LabelState {
  if (record.truth) {
    const kinds = kindsOf(record.truth);
    const answered = Object.entries(record.answer).filter(([, entry]) => entry !== null && typeof entry === "object").map(([question]) => question);
    const settled = (question: string) => kinds.get(question) === "person" || kinds.get(question) === "fact";
    const covered = answered.length > 0 ? answered.every(settled) : [...kinds.values()].some((kind) => kind !== "outcome");
    return covered ? "labelled" : "to_confirm";
  }
  if (Object.keys(record.context).length === 0) return "not_labelable";
  if (record.private === true || (record.context as { conversation?: { private?: unknown } }).conversation?.private === true) return "local_only";
  return scrubContext(record.context).ok ? "queue" : "local_only";
}

/** Printable text: control characters gone (a hostile context cannot paint the terminal), a token shape redacted. */
export const printable = (text: string): string => redact(safe(String(text)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));

const COUNT_LINE: Array<[LabelState, string]> = [["labelled", "labelled"], ["to_confirm", "to confirm"], ["queue", "waiting for a label"], ["local_only", "local only"]];

/** One line per record (pack, time, who asked, engine, what the machine did, the state, the truth's source) and a last line with the counts. No context is ever printed. */
export function recordsReport(records: DecisionRecord[]): { lines: string[]; counts: Record<LabelState, number> } {
  const counts: Record<LabelState, number> = { labelled: 0, to_confirm: 0, queue: 0, local_only: 0, not_labelable: 0 };
  const lines = records.map((r) => {
    const state = labelState(r);
    counts[state] += 1;
    const did = r.acted ? `acted ${r.acted.overall}${r.acted.overrides ? " (repo bars)" : ""}` : `answered ${r.overall}`;
    const truth = r.truth ? `${r.truth.kind ?? "fact"} ${r.truth.source}` : "no truth";
    return printable(`${r.at.slice(0, 19)}Z  ${r.pack}  ${r.engine}  ${r.origin ?? "unknown origin"}  ${did}  ${state}  ${truth}  ${r.id}${r.taskId ? `  task ${r.taskId}` : ""}${r.private ? "  private" : ""}`);
  });
  const total = records.length;
  const parts = COUNT_LINE.map(([state, text]) => `${counts[state]} ${text}`);
  if (counts.not_labelable > 0) parts.push(`${counts.not_labelable} without context`);
  lines.push(`${total} decisions: ${parts.join(", ")}`);
  return { lines, counts };
}

/** The two levels each priority file kept, by the decision record it names (a hint for the person labelling, never a label). */
export function priorityHints(stateDir: string): Map<string, { machineLevel: string | null; personLevel: string }> {
  const hints = new Map<string, { machineLevel: string | null; personLevel: string }>();
  const dir = join(stateDir, "ground-truth", "priority");
  if (!existsSync(dir)) return hints;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, name), "utf8")) as { recordId?: unknown; machineLevel?: unknown; personLevel?: unknown };
      if (typeof body.recordId === "string" && typeof body.personLevel === "string") hints.set(body.recordId, { machineLevel: typeof body.machineLevel === "string" ? body.machineLevel : null, personLevel: body.personLevel });
    } catch {
      // A file that does not parse is not a hint.
    }
  }
  return hints;
}

/** The megabytes under a folder (symlinks are not followed); 0 when it is not there. */
export function folderMegabytes(dir: string): number {
  const bytes = (path: string): number => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return 0;
    return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0) : stat.size;
  };
  return bytes(dir) / (1024 * 1024);
}
