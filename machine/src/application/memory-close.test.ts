import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { noMemory } from "./memory.ts";
import { resolveLessons } from "./memory-approval.ts";
import { recordClose } from "./memory-close.ts";
import type { CloseFactsInput } from "./memory-facts.ts";

const input: CloseFactsInput = {
  card: { id: "card-1", title: "Move the README" },
  repo: "luna-1a2b3c4d",
  source: { kind: "github", ref: "o/a" },
  facts: { predicted: { size: "small", risk: "low", estLoc: 10 }, actual: { added: 5, removed: 1, retries: { verify: 1, e2e: 0, ci: 0, total: 1 }, escalations: 0, format: null, durationMin: 5 }, runs: 3 },
  findings: [{ severity: "high", category: "correctness", path: "README.md" }],
  escalations: [],
  scopeReds: [],
  ciClasses: [],
  dedup: null,
  files: ["README.md"],
  commit: "abc1234",
};
const gate = { lessons: [{ id: "l1", text: "Check links after a move.", kind: "finding", files: ["README.md"], reason: "r" }, { id: "l2", text: "Dropped.", kind: "lesson", files: [], reason: "r" }], retirements: [{ itemId: "mem_0001", text: "Never move it.", lesson: "l1", certainty: "confident" }] };

describe("closing a card writes its memory", () => {
  it("writes the facts, then asks cognify on the datasets touched", async () => {
    const memory = fakeMemory();
    const report = await recordClose(memory, input, resolveLessons(null, undefined));
    expect(report).toEqual({ facts: 2, lessons: 0, retired: 0 });
    expect(memory.items.every((i) => i.trust === "fact" && i.dataset.name === "luna-1a2b3c4d:github")).toBe(true);
    expect(memory.cognified).toEqual([["luna-1a2b3c4d:github"]]);
  });

  it("writes only the approved lessons, as trust lesson from a person, and retires the approved items", async () => {
    const memory = fakeMemory();
    await memory.write([{ kind: "lesson", repo: "luna-1a2b3c4d", source: { kind: "github", ref: "o/a" }, anchors: { files: [], commit: null }, provenance: { by: "person", card: "old", run: null, pack: null }, trust: "lesson", text: "Never move it." }]);
    const report = await recordClose(memory, input, resolveLessons(gate, [{ id: "l1", action: "edit", text: "Check links after any move." }, { id: "l2", action: "drop" }, { id: "mem_0001", action: "approve" }]));
    expect(report).toEqual({ facts: 2, lessons: 1, retired: 1 });
    const lesson = memory.items.find((i) => i.trust === "lesson" && i.text === "Check links after any move.")!;
    expect(lesson).toMatchObject({ kind: "finding", provenance: { by: "person", card: "card-1", pack: "memory_extract" }, anchors: { files: ["README.md"], commit: "abc1234" } });
    expect(memory.items.some((i) => i.text === "Dropped.")).toBe(false);
    expect(memory.items.find((i) => i.id === "mem_0001")!.status).toBe("retired");
  });

  it("does nothing with memory off, and never throws when the port does", async () => {
    expect(await recordClose(noMemory(), input, resolveLessons(null, undefined))).toEqual({ facts: 0, lessons: 0, retired: 0 });
    const broken = { ...fakeMemory(), write: async () => { throw new Error("cognee is down"); } };
    expect(await recordClose(broken, input, resolveLessons(null, undefined))).toEqual({ facts: 0, lessons: 0, retired: 0 });
  });
});
