import { describe, expect, it } from "vitest";

import { stackFieldsOf } from "./card-fields.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-11-06T00:00:00.000Z";

describe("stackFieldsOf", () => {
  it("keeps what the machine gave, and marks the duplicate check as answered so siblings of a split never merge", () => {
    const out = stackFieldsOf({ splitFrom: id(1), splitPart: { n: 2, of: 3 }, dependsOn: [id(2)], startWhenReady: true, riskFloor: "high" }, at);
    expect(out).toEqual({ splitFrom: id(1), splitPart: { n: 2, of: 3 }, dependsOn: [id(2)], startWhenReady: true, riskFloor: "high", dedup: { at, recordId: null, candidates: [], answer: null, outcome: "none", chosen: "neither" } });
  });

  it("drops what is not well formed: an id that is no uuid, a part out of range, a floor that is no level", () => {
    const out = stackFieldsOf({ splitFrom: "../../etc", splitPart: { n: 9, of: 3 }, dependsOn: [id(2), "x; rm -rf", id(2)], startWhenReady: true, riskFloor: "extreme" as never }, at);
    expect(out.splitFrom).toBeUndefined();
    expect(out.splitPart).toBeUndefined();
    expect(out.dependsOn).toEqual([id(2)]);
    expect(out.riskFloor).toBeUndefined();
  });

  it("caps the dependencies at twenty", () => {
    const many = Array.from({ length: 30 }, (_, i) => id(i + 1));
    expect(stackFieldsOf({ dependsOn: many }, at).dependsOn).toHaveLength(20);
  });

  it("is empty for no stack, so a card with none is stored exactly as before", () => {
    expect(stackFieldsOf(undefined, at)).toEqual({});
  });
});
