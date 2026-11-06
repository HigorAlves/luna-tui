import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { tagged } from "../decision-truth.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { memoryReviewRunner } from "./memory.ts";

const context = { task: { id: "t1", repoPath: "/repo" } as unknown as TaskRow, stage: "reviewing_memory", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
const facts = { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 300, removed: 40, retries: { verify: 1, e2e: 0, ci: 1, total: 2 }, escalations: 1, format: "text", durationMin: 20 }, runs: 8 };
const lesson = (text: string, over: Record<string, unknown> = {}) => ({ text, kind: "finding", files: ["README.md"], reason: "recurs", ...over });
const yes = { keep: { value: true, p: 0.95 } };
const no = { keep: { value: false, p: 0.05 } };
const consistent = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`slot${n}`, { choice: "consistent", confidence: 0.95 }]));

function wire(over: { extract?: Array<ReturnType<typeof lesson>> | Error; worth?: (text: string) => Record<string, unknown>; conflict?: Record<string, unknown>; recalled?: Array<{ id: string; kind: string; text: string; stale?: boolean }> } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "memory-"));
  const path = join(stateDir, "rules.md");
  writeFileSync(path, "- r\n");
  const seen: Array<{ pack: string; context: { candidate?: { text: string } } & Record<string, unknown> }> = [];
  const run = memoryReviewRunner({
    runPack: async (): Promise<StageResult> => ({ outcome: "pass", detail: { answer: { incidents: [], patterns: [], proposals: [{ kind: "runbook", title: "Check links", body: "after a move" }], proposedRules: [{ rule: "Run the link check", evidence: [], scope: "repo" }] } }, artifacts: [{ kind: "rules", path, label: "rules.md", sha256: "x" }] }),
    stateDir,
    facts: async () => facts,
    lessons: {
      facts: async () => ["Verify raised 2 high correctness findings in README.md."],
      extract: async (ctx) => {
        seen.push({ pack: "memory_extract", context: ctx as never });
        if (over.extract instanceof Error) throw over.extract;
        return { lessons: over.extract ?? [] } as never;
      },
      recall: async () => (over.recalled ?? []) as never,
      decide: async (pack, ctx) => {
        seen.push({ pack, context: ctx as never });
        return tagged({ answer: pack === "memory_worth" ? (over.worth?.(ctx.candidate!.text) ?? yes) : (over.conflict ?? consistent), recordId: `${pack}-rec` });
      },
    },
  });
  return { run, seen };
}

describe("the retro's lessons (RFC 0007, M2)", () => {
  it("runs memory_extract on the facts and the retro's proposals, and puts the surviving lessons on the gate with the worth record", async () => {
    const { run, seen } = wire({ extract: [lesson("Check relative links after a README move."), lesson("Obvious thing."), lesson("Another lesson about docs.", { kind: "lesson" })], worth: (t) => (t === "Obvious thing." ? no : yes) });
    const result = await run(context);
    expect(seen[0]).toEqual({ pack: "memory_extract", context: { kind: "extract", facts: ["Verify raised 2 high correctness findings in README.md."], proposals: expect.arrayContaining([expect.stringContaining("Check links"), expect.stringContaining("Run the link check")]) } });
    const rules = result.detail!.rules as { lessons: Array<Record<string, unknown>>; retirements: unknown[] };
    expect(rules.lessons).toEqual([
      { id: "l1", text: "Check relative links after a README move.", kind: "finding", files: ["README.md"], reason: "recurs", record: "memory_worth-rec" },
      { id: "l2", text: "Another lesson about docs.", kind: "lesson", files: ["README.md"], reason: "recurs", record: "memory_worth-rec" },
    ]);
    expect(rules.retirements).toEqual([]);
  });

  it("keeps a candidate when memory_worth is unsure: only a confident no drops it", async () => {
    const { run } = wire({ extract: [lesson("Keep me.")], worth: () => ({ keep: { value: false, p: 0.45 } }) });
    expect(((await run(context)).detail!.rules as { lessons: unknown[] }).lessons).toHaveLength(1);
  });

  it("checks each survivor against the recalled active items: a confident contradiction proposes retiring, an unsure one asks, stale and consistent items are left", async () => {
    const recalled = [{ id: "mem_1", kind: "lesson", text: "Never move the README." }, { id: "mem_2", kind: "lesson", text: "Links are checked in CI." }, { id: "mem_3", kind: "finding", text: "Old stale thing.", stale: true }, { id: "mem_4", kind: "lesson", text: "Maybe related." }];
    const conflict = { ...consistent, slot1: { choice: "contradicts", confidence: 0.95 }, slot3: { choice: "unsure", confidence: 0.9 } };
    const { run, seen } = wire({ extract: [lesson("Move the README freely.")], recalled, conflict });
    const rules = (await run(context)).detail!.rules as { retirements: Array<Record<string, unknown>> };
    expect(seen.find((s) => s.pack === "memory_conflict")!.context).toMatchObject({ kind: "conflict", recalled: [{ slot: 1, id: "mem_1" }, { slot: 2, id: "mem_2" }, { slot: 3, id: "mem_4" }] });
    expect(rules.retirements).toEqual([
      { itemId: "mem_1", text: "Never move the README.", lesson: "l1", certainty: "confident", record: "memory_conflict-rec", slot: 1 },
      { itemId: "mem_4", text: "Maybe related.", lesson: "l1", certainty: "unsure", record: "memory_conflict-rec", slot: 3 },
    ]);
  });

  it("never fails the retro: a failed extract is a retro without lessons, and nothing recalled skips the conflict question", async () => {
    const failed = wire({ extract: new Error("no model") });
    const result = await failed.run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail!.rules).toMatchObject({ lessons: [], retirements: [] });
    const quiet = wire({ extract: [lesson("L.")] });
    await quiet.run(context);
    expect(quiet.seen.some((s) => s.pack === "memory_conflict")).toBe(false);
  });

  it("opens the gate for lessons alone when the retro proposed no rules", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "memory-"));
    const run = memoryReviewRunner({
      runPack: async () => ({ outcome: "pass", detail: { answer: { incidents: [], patterns: [] } } }),
      stateDir,
      facts: async () => facts,
      lessons: { facts: async () => [], extract: async () => ({ lessons: [lesson("A lesson.")] }) as never, recall: async () => [], decide: async () => ({ keep: { value: true, p: 0.9 } }) },
    });
    expect((await run(context)).detail!.rules).toMatchObject({ markdown: "", lessons: [{ id: "l1" }] });
  });
});
