import { describe, expect, it } from "vitest";

import { resolveLessons } from "./memory-approval.ts";

const gate = {
  lessons: [
    { id: "l1", text: "Check links after a move.", kind: "finding", files: ["README.md"], reason: "r", record: "w1" },
    { id: "l2", text: "Second lesson.", kind: "lesson", files: [], reason: "r", record: "w2" },
    { id: "l3", text: "Third lesson.", kind: "lesson", files: [], reason: "r" },
  ],
  retirements: [
    { itemId: "mem_1", text: "Never move the README.", lesson: "l1", certainty: "confident", record: "c1", slot: 1 },
    { itemId: "mem_2", text: "Maybe.", lesson: "l2", certainty: "unsure", record: "c1", slot: 2 },
  ],
};

describe("what the retro gate's answer means for memory", () => {
  it("writes an approved lesson as written, an edited one as edited, drops the rest, and labels the worth record each time", () => {
    const out = resolveLessons(gate, [{ id: "l1", action: "approve" }, { id: "l2", action: "edit", text: "  Better wording.  " }]);
    expect(out.write.map((w) => [w.lesson.id, w.text, w.edited])).toEqual([["l1", "Check links after a move.", false], ["l2", "Better wording.", true]]);
    expect(out.truth.filter((t) => t.pack === "memory_worth")).toEqual([
      { pack: "memory_worth", recordId: "w1", label: { keep: { value: true } }, source: "lesson_approved" },
      { pack: "memory_worth", recordId: "w2", label: { keep: { value: true } }, source: "lesson_edited" },
    ]);
  });

  it("labels a dropped lesson, and one the answer does not name, as not worth keeping", () => {
    const out = resolveLessons(gate, [{ id: "l1", action: "drop" }]);
    expect(out.write).toEqual([]);
    expect(out.truth.filter((t) => t.pack === "memory_worth")).toEqual([
      { pack: "memory_worth", recordId: "w1", label: { keep: { value: false } }, source: "lesson_dropped" },
      { pack: "memory_worth", recordId: "w2", label: { keep: { value: false } }, source: "lesson_dropped" },
    ]);
  });

  it("retires an item only when a person approved it and kept the lesson that contradicts it; the slot's truth follows the answer", () => {
    const out = resolveLessons(gate, [{ id: "l1", action: "approve" }, { id: "mem_1", action: "approve" }, { id: "mem_2", action: "approve" }]);
    expect(out.retire.map((r) => r.itemId)).toEqual(["mem_1"]);
    expect(out.truth.filter((t) => t.pack === "memory_conflict")).toEqual([
      { pack: "memory_conflict", recordId: "c1", label: { slot1: { choice: "contradicts" } }, source: "retirement_approved" },
      { pack: "memory_conflict", recordId: "c1", label: { slot2: { choice: "consistent" } }, source: "retirement_dropped" },
    ]);
  });

  it("does nothing without a list of answers: an older client or a gate with no lessons writes, retires and labels nothing", () => {
    expect(resolveLessons(gate, undefined)).toEqual({ write: [], retire: [], truth: [] });
    expect(resolveLessons(null, [{ id: "l1", action: "approve" }])).toEqual({ write: [], retire: [], truth: [] });
  });

  it("ignores a malformed answer and caps an edit at 400 characters", () => {
    const out = resolveLessons(gate, [{ id: "l1", action: "edit", text: "x".repeat(900) }, { nonsense: true }, { id: "l2", action: "bogus" }]);
    expect(out.write).toHaveLength(1);
    expect(out.write[0]!.text).toHaveLength(400);
  });
});
