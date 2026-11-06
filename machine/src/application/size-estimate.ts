// Change size at Plan (wave 15). Scripts around the `size_estimate` decision: the context it reads
// (every stranger's text flattened and capped), the nearest closed cards with a counted diff, and
// the assessment the plan stage records: what the decision said, what the plan's own estimates add
// up to, the verdict against the repository's limits, and the flags the gate shows. Pure.
import { type SizeContext, type SizeLimits, filesOf, locOf, sizeVerdict } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import { type Candidate, similar } from "../domain/similarity.ts";

const cap = (text: string, max: number): string => {
  const flat = safe(text);
  return flat.length > max ? flat.slice(0, max) : flat;
};

export type SizedCard = Candidate & { diffAdded: number | null; diffRemoved: number | null };

/** The nearest closed cards of the same repository that have a counted diff (what they really came to), five at most. */
export function similarCards(card: { title: string; text: string; repo: string | null }, cards: SizedCard[], options: { now: Date; lookbackDays: number }): { title: string; added: number; removed: number }[] {
  const counted = cards.filter((c) => c.kind === "closed" && c.repo === card.repo && c.diffAdded !== null && c.diffRemoved !== null);
  const byId = new Map(counted.map((c) => [c.id, c]));
  return similar(card, counted, options).flatMap((near) => {
    const found = byId.get(near.id);
    return found ? [{ title: cap(found.title, 200), added: found.diffAdded!, removed: found.diffRemoved! }] : [];
  });
}

/** The context size_estimate reads, from a ticket or record and what the code map named. */
export function sizeContextOf(input: { title: string; text: string; criteria: string[]; files: { path: string; role?: string }[]; symbols: string[]; similar: { title: string; added: number; removed: number }[]; limits: Pick<SizeLimits, "target" | "hard"> }): SizeContext {
  return {
    title: cap(input.title, 500),
    text: cap(input.text, 4000),
    criteria: input.criteria.slice(0, 20).map((c) => cap(c, 500)),
    files: input.files.slice(0, 40).map((f) => ({ path: cap(f.path, 300), ...(f.role ? { role: cap(f.role, 100) } : {}) })),
    symbols: input.symbols.slice(0, 40).map((s) => cap(s, 200)),
    similar: input.similar.slice(0, 5).map((s) => ({ title: cap(s.title, 200), added: s.added, removed: s.removed })),
    limit: { target: input.limits.target, hard: input.limits.hard },
  };
}

/** What the decision's answer comes to once the policy has looked at it: lines (from the score), files, whether a confident "not reviewable" stands, and whether `est_loc` was sure enough to act on. */
export type SizeDecision = { estLoc: number; estFiles: number; reviewableNo: boolean; sure: boolean; confidence: number };

export type SizeDetail = {
  estLoc: number | null;
  estFiles: number | null;
  reviewable: boolean | null;
  confidence: number | null;
  planned: number | null;
  limit: { target: [number, number]; hard: number };
  verdict: "over" | "over_target" | "within";
  by: "decision" | "plan";
};

/** The detail the stage records and the flags the gate shows. The plan's own sum rules once there is a plan; a decision that was not sure rules nothing. */
export function sizeAssessment(input: { decision: SizeDecision | null; planned: number | null; limits: Pick<SizeLimits, "target" | "hard"> }): { size: SizeDetail; flags: string[] } {
  const { decision, planned, limits } = input;
  const byPlan = planned !== null && planned > 0;
  const ruling = byPlan ? planned : decision?.sure ? decision.estLoc : null;
  const verdict = ruling === null ? "within" : sizeVerdict(ruling, limits);
  const size: SizeDetail = {
    estLoc: decision?.estLoc ?? null,
    estFiles: decision?.estFiles ?? null,
    reviewable: decision ? !decision.reviewableNo : null,
    confidence: decision?.confidence ?? null,
    planned: byPlan ? planned : null,
    limit: { target: limits.target, hard: limits.hard },
    verdict,
    by: byPlan ? "plan" : "decision",
  };
  const flags: string[] = [];
  if (verdict === "over") flags.push("over the size limit");
  else if (verdict === "over_target") flags.push("size over target");
  if (decision?.sure && byPlan && (decision.estLoc > planned * 2 || planned > decision.estLoc * 2)) flags.push("size unsure");
  if (verdict === "within" && decision?.reviewableNo) flags.push("size: hard to review as one change");
  return { size, flags };
}

/** A decision's answer as lines and files; `sure` is the policy's say on `est_loc`, `reviewableSure` its say on `reviewable`. */
export function sizeDecisionOf(answer: Record<string, unknown>, policy: { sure: boolean; reviewableSure: boolean }): SizeDecision {
  const num = (q: string, key: string): number => Number((answer[q] as Record<string, unknown> | undefined)?.[key] ?? 0);
  const filesScore = num("est_files", "score");
  const reviewable = (answer.reviewable as { value?: unknown } | undefined)?.value;
  return {
    estLoc: locOf(num("est_loc", "score")),
    estFiles: filesOf(filesScore),
    reviewableNo: policy.reviewableSure && reviewable === false,
    sure: policy.sure,
    confidence: num("est_loc", "confidence"),
  };
}
