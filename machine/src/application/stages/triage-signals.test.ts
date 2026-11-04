import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageRunner } from "../ports.ts";
import { withTriageSignals } from "./triage-signals.ts";

const task = (over: Partial<TaskRow> = {}): TaskRow => ({ id: "t1", title: "Which Postgres?", description: "Is 14 fine?", criteria: [], repoPath: "/repo", source: { kind: "github", repo: "o/n", number: 7, url: "https://github.com/o/n/issues/7" }, classification: null, ...over }) as unknown as TaskRow;
const context = (over: Partial<StageContext> = {}): StageContext => ({ task: task(), stage: "triage", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal, ...over });
const classification = { kind: "bug", area: "board", ready: true, size: 1, urgency: 2, risk: 1, archive: false, archiveReason: "none", confidence: 0.8, at: "2026-11-04T00:00:00.000Z", model: "m", signals: {} };

describe("withTriageSignals", () => {
  it("classifies a ticket that arrived without signals, saves them and hands them to triage", async () => {
    const saved: unknown[] = [];
    let seen: TaskRow | undefined;
    const inner: StageRunner = async (c) => {
      seen = c.task;
      return { outcome: "pass" };
    };
    const asked: unknown[] = [];
    const runner = withTriageSignals(inner, {
      classify: async (issue, repoPath) => {
        asked.push([issue, repoPath]);
        return classification;
      },
      save: async (id, patch) => {
        saved.push([id, patch]);
      },
    });
    await runner(context());
    expect(asked).toEqual([[{ title: "Which Postgres?", description: "Is 14 fine?", labels: [], source: "https://github.com/o/n/issues/7" }, "/repo"]]);
    expect(saved).toEqual([["t1", { classification }]]);
    expect(seen?.classification).toEqual(classification);
  });

  it("leaves a classified ticket alone and survives a classifier that throws or answers nothing", async () => {
    let calls = 0;
    const seen: Array<TaskRow["classification"]> = [];
    const inner: StageRunner = async (c) => {
      seen.push(c.task.classification);
      return { outcome: "pass" };
    };
    const saved: unknown[] = [];
    const save = async (id: string, patch: unknown) => void saved.push([id, patch]);
    const classify = async () => {
      calls++;
      return classification;
    };
    await withTriageSignals(inner, { classify, save })(context({ task: task({ classification }) }));
    expect(calls).toBe(0);
    expect(seen[0]).toEqual(classification);

    const lines: string[] = [];
    await withTriageSignals(inner, { classify: async () => Promise.reject(new Error("boom")), save, log: (l) => lines.push(l) })(context());
    await withTriageSignals(inner, { classify: async () => null, save })(context());
    await withTriageSignals(inner, { classify: null, save })(context());
    expect(seen.slice(1)).toEqual([null, null, null]);
    expect(saved).toEqual([]);
    expect(lines).toEqual([expect.stringContaining("boom")]);
  });
});
