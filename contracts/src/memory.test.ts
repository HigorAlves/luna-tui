import { describe, expect, it } from "vitest";

import { MEMORY_CONTEXT_MAX_BYTES, MEMORY_CONTEXT_MAX_ITEMS, MemoryContext, MemoryItem, StageInput } from "./index.ts";

const item = {
  id: "mem_0001",
  kind: "finding",
  repo: "luna-tui-1a2b3c4d",
  source: { kind: "github", ref: "owner/repo#12" },
  dataset: { name: "luna-tui-1a2b3c4d:github", id: null },
  cogneeDataId: null,
  anchors: { files: ["board/README.md"], commit: "abc1234" },
  provenance: { by: "machine", card: "893545bc", run: null, pack: null },
  trust: "fact",
  status: "pending",
  text: "Verify found broken relative links in board/README.md after the README moved.",
  contentHash: "5691b07733fcd7dc9e86970115bb0074",
  createdAt: "2026-11-06T22:00:00.000Z",
};

describe("MemoryItem", () => {
  it("accepts an item the machine wrote from its own records", () => {
    expect(MemoryItem.safeParse(item).error).toBeUndefined();
  });

  it("caps the text a pack or template writes at 400 characters", () => {
    expect(MemoryItem.safeParse({ ...item, text: "x".repeat(401) }).success).toBe(false);
  });

  it("allows a company document with no repository", () => {
    expect(MemoryItem.safeParse({ ...item, kind: "doc", repo: null, source: { kind: "doc", ref: "handbook.pdf" }, dataset: { name: "company", id: null } }).success).toBe(true);
  });

  it("refuses an unknown trust level", () => {
    expect(MemoryItem.safeParse({ ...item, trust: "trusted" }).success).toBe(false);
  });
});

describe("MemoryContext", () => {
  const recalled = { id: "mem_0001", kind: "finding", text: "broken links after a move", source: "github", anchors: { files: ["board/README.md"], commit: "abc1234" }, stale: false, score: 0.42 };

  it("is what a stage input carries as context.memory", () => {
    const input = { schema: 3, stage: "test_design", pack: "plan", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "/r", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null, memory: { items: [recalled], note: null } }, limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
    expect(StageInput.safeParse(input).error).toBeUndefined();
  });

  it(`holds at most ${MEMORY_CONTEXT_MAX_ITEMS} items`, () => {
    const items = Array.from({ length: MEMORY_CONTEXT_MAX_ITEMS + 1 }, (_, i) => ({ ...recalled, id: `mem_${i}` }));
    expect(MemoryContext.safeParse({ items, note: null }).success).toBe(false);
  });

  it("keeps the byte cap a stage input's memory block is cut to", () => {
    expect(MEMORY_CONTEXT_MAX_BYTES).toBe(4096);
  });
});
