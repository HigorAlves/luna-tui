import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { noMemory } from "./memory.ts";
import { capItems, memoryAnswers, recallBlock, toolAnswer, viewerForRun } from "./memory-recall.ts";
import { viewerOfCard } from "./memory-similar.ts";

const base = { repo: "r", anchors: { files: ["README.md"], commit: null }, trust: "fact" as const, provenance: { by: "machine" as const, card: "c1", run: null, pack: null } };
const gh = viewerForRun(viewerOfCard({ repoSlug: "r", source: { kind: "github", repo: "o/a", number: 1, url: "u" } }), "plan", "github");

async function seeded() {
  const memory = fakeMemory();
  await memory.write([
    { ...base, kind: "finding", source: { kind: "github", ref: "o/a" }, text: "Verify found broken readme links after a README move." },
    { ...base, kind: "finding", source: { kind: "slack", ref: "C9" }, text: "Private slack readme links finding." },
    { ...base, kind: "lesson", source: { kind: "github", ref: "o/a" }, trust: "lesson", text: "Check readme links after any move." },
  ]);
  return memory;
}

describe("the viewer of a run", () => {
  it("takes publicPost from the pack and the source, never a literal", () => {
    const card = (source: Parameters<typeof viewerOfCard>[0]["source"]) => viewerOfCard({ repoSlug: "r", source });
    expect(viewerForRun(card(null), "plan", null).publicPost).toBe(false);
    expect(viewerForRun(card(null), "pr_reply", null).publicPost).toBe(true);
    expect(viewerForRun(card({ kind: "github", repo: "o/a", number: 1, url: "u" }), "plan", "github").publicPost).toBe(true);
    expect(viewerForRun(card({ kind: "slack", channel: "C1", ts: "1", permalink: "p" }), "plan", "slack").publicPost).toBe(false);
  });
});

describe("the pushed block", () => {
  it("recalls the card's goal and files, from the card's own source only", async () => {
    const block = await recallBlock(await seeded(), { pack: "plan", viewer: gh, goal: "Move the readme and fix links", files: ["README.md"] });
    expect(block?.items.map((i) => i.kind).sort()).toEqual(["finding", "lesson"]);
    expect(block?.items.some((i) => i.text.includes("Private"))).toBe(false);
  });

  it("is undefined with memory off, and an empty block with a note when recall fails", async () => {
    expect(await recallBlock(noMemory(), { pack: "plan", viewer: gh, goal: "x", files: [] })).toBeUndefined();
    const broken = { ...fakeMemory(), recall: async () => { throw new Error("cognee is down"); } };
    expect(await recallBlock(broken, { pack: "plan", viewer: gh, goal: "x", files: [] })).toEqual({ items: [], note: "memory recall failed: cognee is down" });
  });

  it("is capped at twelve items and 4 KB, and says so", () => {
    const item = (n: number, size: number) => ({ id: `m${n}`, kind: "finding" as const, text: "x".repeat(size), source: "github" as const, anchors: { files: [], commit: null }, stale: false, score: 1 });
    const many = capItems(Array.from({ length: 20 }, (_, n) => item(n, 10)));
    expect(many.items).toHaveLength(12);
    expect(many.cut).toBe(true);
    const big = capItems(Array.from({ length: 12 }, (_, n) => item(n, 900)));
    expect(big.items.length).toBeLessThan(12);
    expect(big.cut).toBe(true);
    expect(capItems([item(1, 10)]).cut).toBe(false);
  });
});

describe("the memory_recall tool", () => {
  it("answers with the same viewer, per scope", async () => {
    const memory = await seeded();
    const out = (await toolAnswer(memory, { query: "readme links", scope: "memory" }, gh)) as { items: Array<{ text: string }> };
    expect(out.items).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain("Private");
    expect(await toolAnswer(memory, { query: "readme links", scope: "docs" }, gh)).toMatchObject({ items: [] });
  });

  it("asks the code graph for `search` on scope code, and says when there is none", async () => {
    const memory = fakeMemory();
    expect(await toolAnswer(memory, { query: "login", scope: "code" }, gh)).toMatchObject({ code: null });
    await memory.ingestCode({ repo: "r", dir: "/d", commit: "abc" });
    expect(await toolAnswer(memory, { query: "login", scope: "code" }, gh)).toMatchObject({ verdict: "ok", code: { operation: "search" } });
  });

  it("writes its answer through the mailbox hook", async () => {
    const written: Array<Record<string, unknown>> = [];
    await memoryAnswers({ memory: await seeded(), viewer: gh, write: async (a) => void written.push(a) }).onMemoryRecall({ query: "readme", scope: "memory" });
    expect(written[0]).toMatchObject({ verdict: "ok" });
  });
});
