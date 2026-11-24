import { describe, expect, it } from "vitest";

import { designSpecDue } from "./design-routing.ts";

const ref = { refs: [{ fileKey: "AbCdEf0123456789", nodeIds: [], page: null, from: "issue" as const }] };

describe("designSpecDue", () => {
  it("runs on a frontend card or a card with a design reference, on the full lane", () => {
    expect(designSpecDue({ off: false, cardOff: false, typeOfWork: "frontend", ref: null, lane: "full" })).toEqual({ due: true });
    expect(designSpecDue({ off: false, cardOff: false, typeOfWork: "backend", ref, lane: "full" })).toEqual({ due: true });
    expect(designSpecDue({ off: false, cardOff: false, typeOfWork: "backend", ref: null, lane: "full" })).toEqual({ due: false, why: "not a UI card and no design reference" });
  });
  it("runs on the fast lane only with a design reference", () => {
    expect(designSpecDue({ off: false, cardOff: false, typeOfWork: "frontend", ref: null, lane: "fast" }).due).toBe(false);
    expect(designSpecDue({ off: false, cardOff: false, typeOfWork: "frontend", ref, lane: "fast" }).due).toBe(true);
  });
  it("never runs when the repo or the card turned design off", () => {
    expect(designSpecDue({ off: true, cardOff: false, typeOfWork: "frontend", ref, lane: "full" })).toEqual({ due: false, why: "luna.yaml says design: off" });
    expect(designSpecDue({ off: false, cardOff: true, typeOfWork: "frontend", ref, lane: "full" })).toEqual({ due: false, why: "a person turned design off for this card" });
  });
});
