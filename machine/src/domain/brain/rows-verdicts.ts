// Rows of the company brain for decision packs' verdicts (RFC 0010): one per answered question whose
// truth is known, since the graph holds verdicts only as precedents. The record's context, which can
// carry code and paths, never goes in; a row has the answer and the truth as short tokens.
import { PACKS, brainEdge, brainNode, brainSlug, brainTime, confidenceOf, type DecisionRecord, type Question, type TruthKind } from "@hardness/contracts";
import type { BrainRow } from "@hardness/contracts";

/** An answer or a label as one short token; null when it is not in the shape its question gives (a set of possible labels, for one). */
function token(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const shaped = value as Record<string, unknown>;
  if (typeof shaped.choice === "string") return shaped.choice;
  if (typeof shaped.value === "boolean") return shaped.value ? "yes" : "no";
  if (typeof shaped.score === "number" && Number.isFinite(shaped.score)) return String(shaped.score);
  return null;
}

function confidence(pack: DecisionRecord["pack"], question: string, answer: unknown): number | null {
  const spec = PACKS[pack];
  const asked: Question | undefined = spec.kind === "decision" ? spec.questions[question] : undefined;
  if (!asked) return null;
  const sure = confidenceOf(asked, answer);
  return typeof sure === "number" && Number.isFinite(sure) ? sure : null;
}

/** `hasCard`: the graph holds the card of the record's task, or this load carries it; the server refuses an edge to a node it does not have. */
export function verdictRows(record: DecisionRecord, context: { hasCard: boolean }): BrainRow[] {
  const { truth } = record;
  if (!truth) return [];
  const rows: BrainRow[] = [];
  for (const [question, label] of Object.entries(truth.label)) {
    const known = token(label);
    const answered = token(record.answer[question]);
    if (known === null || answered === null) continue;
    // The question's own kind beats the truth's latest: a person's word on one question stays a person's.
    const kind: TruthKind = truth.kinds?.[question] ?? truth.kind ?? "fact";
    const slug = brainSlug("verdict", `${record.pack}/${record.id}/${question}`);
    rows.push(
      brainNode("Verdict", {
        slug,
        pack: record.pack,
        question,
        answer: answered,
        confidence: confidence(record.pack, question, record.answer[question]),
        truth: known,
        truth_source: kind === "person" ? "person" : "outcome",
        decided_at: brainTime(record.at),
      }),
    );
    if (record.taskId && context.hasCard) rows.push(brainEdge("VerdictOn", slug, brainSlug("card", record.taskId)));
  }
  return rows;
}
