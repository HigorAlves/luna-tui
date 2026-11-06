// The exit criterion of the ground-truth loop: every decision pack, asked by the machine's own callers with the context its eval case holds,
// leaves one record whose origin is the machine and whose context is kept (the default config), so a person can label it.
// It drives the packs through PackRuns with a fake container, not a card through the whole pipeline: the pipeline's own tests
// show each stage asks its pack, and this one shows that what any ask leaves is a record fit to label.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type DecisionRecord, PACKS, type PackId, type StageOutput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";
import { CONTEXT_OF, type ContextPackId } from "../domain/context-packs.ts";
import { PackRuns, ownCalls } from "./pack-runs.ts";

const EVALS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "evals");
const decisionPacks = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id) as PackId[];

const answerOf = (pack: PackId) =>
  Object.fromEntries(
    Object.entries((PACKS[pack] as { questions: Record<string, { type: string; criteria?: Record<string, string> }> }).questions).map(([name, q]) => [name, q.type === "choice" ? { choice: Object.keys(q.criteria!)[0], confidence: 0.9 } : q.type === "yesno" ? { value: true, p: 0.9 } : { score: 0, confidence: 0.9 }]),
  );

const output = (answer: Record<string, unknown>): StageOutput => ({
  schema: 3, ok: true, outcome: "pass", summary: "", answer, needsInput: null, requested: [], findings: [], artifacts: [], slices: { done: 0, total: 0 }, commit: null,
  usage: { turns: 1, costUsd: 0.001, durationMs: 100, model: "m" }, error: null, rateLimited: false, resetsAt: null,
});

/** The context of the pack's first eval case, as the machine gives it to the pack. */
function caseContext(pack: PackId): Record<string, unknown> {
  const cases = join(EVALS, pack, "cases");
  const first = readdirSync(cases).sort()[0]!;
  const stage = JSON.parse(readFileSync(join(cases, first, "stage.json"), "utf8")) as { context: Record<string, unknown> };
  const key = CONTEXT_OF[pack as ContextPackId].key;
  return { [key]: stage.context[key] };
}

describe("every decision pack leaves a record a person can label", () => {
  for (const pack of decisionPacks) {
    it(pack, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "pipeline-records-"));
      const appended: DecisionRecord[] = [];
      const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
        mkdirSync(join(run.runDir, "out"), { recursive: true });
        writeFileSync(join(run.runDir, "out", "result.json"), JSON.stringify(output(answerOf(pack))));
        return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
      };
      const runs = new PackRuns({ image: "x", credentials: { check: async () => ({ available: true }), prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) }, stateDir, store: { record: async () => {} }, sandbox, now: () => new Date("2026-11-06T00:00:00Z"), log: () => {}, decisions: { append: async (record) => void appended.push(record) } });
      await ownCalls(runs).run({ pack, context: caseContext(pack) } as never, "intake");
      expect(appended).toHaveLength(1);
      expect(appended[0]!.origin).toBe("machine");
      expect(Object.keys(appended[0]!.context).length).toBeGreaterThan(0);
      expect(appended[0]!.truth).toBeUndefined();
    });
  }
});
