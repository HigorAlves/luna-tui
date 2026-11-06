import { describe, expect, it } from "vitest";

import { relationOf } from "./conversation-relation.ts";

const shortlist = [
  { slot: 1, id: "card-open", kind: "open" as const, otherSource: null },
  { slot: 2, id: "card-old", kind: "closed" as const, otherSource: { kind: "jira" as const, key: "ENG-1" } },
  { slot: 3, id: "backlog-1", kind: "backlog" as const, otherSource: null },
];
const answer = (related: string, confidence: number, newWork?: { value: boolean; p: number }) => ({ related: { choice: related, confidence }, new_work: newWork ?? { value: false, p: 0.1 } });

describe("relationOf", () => {
  it("is related to work in progress for a sure slot that holds a card, open or closed inside the lookback", () => {
    expect(relationOf(answer("slot1", 0.9), shortlist, "bug", 0.7)).toMatchObject({ type: "related_to_in_progress", target: "card-open", confidence: 0.9 });
    expect(relationOf(answer("slot2", 0.8), shortlist, "bug", 0.7)).toMatchObject({ type: "related_to_in_progress", target: "card-old", otherSource: { kind: "jira", key: "ENG-1" } });
  });
  it("is related to the backlog for a sure slot that holds a backlog item", () => {
    expect(relationOf(answer("slot3", 0.75), shortlist, "request", 0.7)).toMatchObject({ type: "related_to_backlog", target: "backlog-1", otherSource: null });
  });
  it("asks for a slot below the bar, and for a slot the shortlist does not hold", () => {
    expect(relationOf(answer("slot1", 0.5), shortlist, "bug", 0.7)).toMatchObject({ type: "ask", target: null });
    expect(relationOf(answer("slot5", 0.99), shortlist, "bug", 0.7)).toMatchObject({ type: "ask", target: null });
  });
  it("is a new candidate for a sure none with a sure new_work of an incident, a bug or a request", () => {
    for (const kind of ["incident", "bug", "request"]) expect(relationOf(answer("none", 0.9, { value: true, p: 0.85 }), shortlist, kind, 0.7)).toMatchObject({ type: "new_candidate", target: null });
  });
  it("is none for a sure none otherwise: a question, no new work, or an unsure new_work", () => {
    expect(relationOf(answer("none", 0.9, { value: true, p: 0.9 }), shortlist, "question", 0.7).type).toBe("none");
    expect(relationOf(answer("none", 0.9, { value: false, p: 0.1 }), shortlist, "bug", 0.7).type).toBe("none");
    expect(relationOf(answer("none", 0.9, { value: true, p: 0.55 }), shortlist, "bug", 0.7).type).toBe("none");
  });
  it("asks when the none itself is unsure", () => {
    expect(relationOf(answer("none", 0.4, { value: true, p: 0.9 }), shortlist, "bug", 0.7).type).toBe("ask");
  });
});
