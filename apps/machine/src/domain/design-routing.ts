// Whether the plan stage asks for a design spec (RFC 0013, Routing; D8): a UI card or a card with a design reference on the full lane, a card with a
// reference on the fast lane, never when the repo or a person turned design off. Pure.
import type { DesignContext, TriageRecord } from "@hardness/contracts";

export function designSpecDue(input: { off: boolean; cardOff: boolean; typeOfWork: TriageRecord["typeOfWork"] | undefined; ref: DesignContext | null; lane: "fast" | "full" }): { due: true } | { due: false; why: string } {
  if (input.off) return { due: false, why: "luna.yaml says design: off" };
  if (input.cardOff) return { due: false, why: "a person turned design off for this card" };
  if (input.ref) return { due: true };
  if (input.lane === "fast") return { due: false, why: "a fast-lane card with no design reference" };
  return input.typeOfWork === "frontend" ? { due: true } : { due: false, why: "not a UI card and no design reference" };
}
