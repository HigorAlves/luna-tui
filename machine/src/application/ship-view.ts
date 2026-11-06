// What the board shows of a watched PR, built from the ship cursor alone (pure). The monitor stores the last poll's readiness in the cursor (`viewSnapshot`);
// nothing here reads GitHub, and nothing a reviewer wrote is in the cursor's view: a checklist detail can name a check or a file, so it is flattened and capped on the way out.
import type { ShipView } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { MergeReadiness } from "../domain/merge-readiness.ts";
import type { ReviewRequirement } from "../domain/review-rule.ts";
import type { ShipCursor } from "./ship-cursor.ts";

const TEXT_CAP = 300;
const text = (value: string): string => safe(value).slice(0, TEXT_CAP);

/** The part of a poll's facts the board keeps. */
export function viewSnapshot(facts: { head: string | null; readiness: MergeReadiness; review: ReviewRequirement }, at: string): NonNullable<ShipCursor["view"]> {
  const { readiness, review } = facts;
  return {
    head: facts.head,
    ready: readiness.ready,
    checklist: readiness.checklist.map((i) => ({ id: i.id, ok: i.ok, detail: i.detail })),
    canAutoMerge: readiness.canAutoMerge,
    reason: readiness.reason,
    reviewRequired: review.required,
    reviewBy: review.required === true ? review.by : null,
    at,
  };
}

export function shipViewOf(cursor: ShipCursor | null): ShipView | null {
  if (!cursor) return null;
  const view = cursor.view;
  return {
    pr: { slug: cursor.pr.slug, number: cursor.pr.number, url: `https://github.com/${cursor.pr.slug}/pull/${cursor.pr.number}` },
    head: view?.head ?? null,
    ready: view?.ready ?? false,
    checklist: (view?.checklist ?? []).map((i) => ({ id: i.id.replace(/[^a-z_]/g, "").slice(0, 40), ok: i.ok, detail: text(i.detail) })),
    autoMerge: { allowed: view?.canAutoMerge ?? false, reason: text(view?.reason ?? "not read yet") },
    review: { required: view?.reviewRequired ?? null, by: view?.reviewBy ? text(view.reviewBy) : null },
    fixRounds: cursor.fixRounds,
    queued: cursor.queued === true,
    quietSince: cursor.lastActivityAt ?? null,
    lastEvent: cursor.lastEvent ? { class: cursor.lastEvent.class.replace(/[^a-z_]/g, "").slice(0, 40), at: cursor.lastEvent.at } : null,
    at: view?.at ?? null,
  };
}
