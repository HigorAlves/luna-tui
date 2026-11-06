import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConversationTruth } from "./conversation-truth.ts";

const classification = { kind: "bug", confidence: 0.9, by: "model" as const, at: "2026-10-28T00:00:00.000Z", records: { assess: "rec-1" }, verdict: "ok" as const, priority: "P0", knockOut: "production_down", total: 22, scores: { who: { score: 3, confidence: 0.9 } } };

describe("ConversationTruth", () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), "truth-"));
    const learned: unknown[] = [];
    const truth = new ConversationTruth(dir, { learned: async (f) => (learned.push(f), true) }, () => new Date("2026-10-28T12:00:00Z"));
    return { dir, learned, truth };
  };
  it("a hand-set kind writes the file (mode 0600) and labels the kind on the assess record", async () => {
    const { dir, learned, truth } = await setup();
    await truth.override({ thread: "C1:1700000000.000000", classification, kind: "question" });
    const files = (await import("node:fs/promises")).readdir(join(dir, "ground-truth", "conversation"));
    const [name] = await files;
    expect(name).toMatch(/^C1_1700000000\.000000-/);
    const path = join(dir, "ground-truth", "conversation", name!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ record: "rec-1", machine: { kind: "bug", priority: "P0" }, person: { kind: "question" } });
    expect(learned).toEqual([{ pack: "conversation_assess", recordId: "rec-1", label: { kind: { choice: "question" } }, source: "person" }]);
  });
  it("a knock-out P0 lowered by hand labels that flag false; any other priority change labels nothing", async () => {
    const { learned, truth } = await setup();
    await truth.override({ thread: "C1:1.0", classification, priority: "P2" });
    expect(learned).toEqual([{ pack: "conversation_assess", recordId: "rec-1", label: { production_down: { value: false } }, source: "person" }]);
    learned.length = 0;
    await truth.override({ thread: "C1:1.0", classification: { ...classification, knockOut: null, priority: "P1" }, priority: "P3" });
    expect(learned).toEqual([]);
  });
});
