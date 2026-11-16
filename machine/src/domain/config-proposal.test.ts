import type { Effort, EngineId, PackId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { CALM, type Candidate, CHEAPER, DECLINE_DAYS, GAIN, MAX_CHANGES, MIN_CASES, MIN_RUNS, type ProposalInput, type RepoSignal, TOLERANCE, TROUBLE, proposeConfig } from "./config-proposal.ts";

const NOW = "2026-11-16T12:00:00.000Z";
const candidate = (engine: EngineId, effort: Effort | null, quality: number, costPerCase: number, n = 5): Candidate => ({ engine, effort, n, quality, costPerCase, at: "2026-11-01" });
const signal = (runs: number, trouble: number, stuck = 0): RepoSignal => ({ runs, escalations: trouble, stuck, costUsd: 1 });

/** `plan` runs claude:opus at high by default and also allows codex:sol. */
const base = (over: Partial<ProposalInput> = {}): ProposalInput => ({ current: { engines: {}, effort: {} }, candidates: {}, signals: {}, declined: [], now: NOW, ...over });

describe("the rule's constants", () => {
  it("are the plan's numbers", () => {
    expect([MIN_CASES, MIN_RUNS, TOLERANCE, CHEAPER, TROUBLE, CALM, GAIN, DECLINE_DAYS, MAX_CHANGES]).toEqual([3, 10, 0.05, 0.7, 0.25, 0.1, 0.1, 30, 3]);
  });
});

describe("proposeConfig", () => {
  it("steps up when a pack is in trouble and a candidate is clearly better", () => {
    const changes = proposeConfig(
      base({
        candidates: { plan: [candidate("claude:opus", "high", 0.67, 1), candidate("codex:sol", "high", 0.83, 1.2), candidate("codex:sol", "medium", 0.7, 0.5)] },
        signals: { plan: signal(12, 4) },
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ pack: "plan", engine: { from: "claude:opus", to: "codex:sol" }, effort: null });
    expect(changes[0]!.why).toBe("plan escalated 4 of 12 runs; codex:sol at high passed 0.83 vs 0.67");
    expect(changes[0]!.evidence.current.engine).toBe("claude:opus");
    expect(changes[0]!.evidence.next.engine).toBe("codex:sol");
    expect(changes[0]!.evidence.signal.runs).toBe(12);
  });

  it("breaks a step-up tie on the lower cost", () => {
    const changes = proposeConfig(
      base({
        candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.8, 2), candidate("claude:opus", "medium", 0.8, 1.5)] },
        signals: { plan: signal(10, 5) },
      }),
    );
    expect(changes[0]).toMatchObject({ engine: null, effort: { from: "high", to: "medium" } });
  });

  it("counts a stuck loop as trouble and says so", () => {
    const changes = proposeConfig(base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.8, 1)] }, signals: { plan: signal(10, 1, 2) } }));
    expect(changes[0]!.why).toBe("plan escalated 1 and got stuck 2 of 10 runs; codex:sol at high passed 0.80 vs 0.50");
  });

  it("steps down when a pack is calm and a candidate is much cheaper at about the same quality", () => {
    const changes = proposeConfig(
      base({
        candidates: { plan: [candidate("claude:opus", "high", 0.9, 1), candidate("claude:opus", "low", 0.86, 0.7), candidate("claude:opus", "medium", 0.88, 0.5), candidate("codex:sol", "low", 0.5, 0.1)] },
        signals: { plan: signal(20, 1) },
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ pack: "plan", engine: null, effort: { from: "high", to: "medium" } });
    expect(changes[0]!.why).toBe("plan escalated 1 of 20 runs; claude:opus at medium passed 0.88 vs 0.90 at $0.50 a case vs $1.00");
  });

  it("proposes nothing between calm and trouble", () => {
    const input = base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.9, 0.1)] }, signals: { plan: signal(20, 3) } });
    expect(proposeConfig(input)).toEqual([]);
  });

  it("proposes nothing without enough runs", () => {
    const input = base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.9, 1)] }, signals: { plan: signal(9, 9) } });
    expect(proposeConfig(input)).toEqual([]);
    expect(proposeConfig({ ...input, signals: {} })).toEqual([]);
  });

  it("skips a pack whose current pair has no baseline, or too few cases", () => {
    const better = candidate("codex:sol", "high", 0.9, 1);
    const trouble = { plan: signal(12, 6) };
    expect(proposeConfig(base({ candidates: { plan: [candidate("claude:opus", "low", 0.5, 1), better] }, signals: trouble }))).toEqual([]);
    expect(proposeConfig(base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1, 2), better] }, signals: trouble }))).toEqual([]);
  });

  it("reads the repo's own pair as the current one", () => {
    const input = base({
      current: { engines: { plan: "codex:sol" }, effort: { plan: "low" } },
      candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "low", 0.5, 1), candidate("codex:sol", "high", 0.9, 1)] },
      signals: { plan: signal(12, 6) },
    });
    expect(proposeConfig(input)[0]).toMatchObject({ engine: null, effort: { from: "low", to: "high" } });
  });

  it("never proposes an engine the pack does not allow", () => {
    const input = base({ candidates: { setup: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.9, 1)] }, signals: { setup: signal(12, 6) } });
    expect(proposeConfig(input)).toEqual([]);
  });

  it("never proposes an effort the engine cannot run", () => {
    // A decision pack takes no effort, so a candidate that names one is not valid.
    const input = base({
      candidates: { risk_score: [candidate("codex:luna", null, 0.5, 1), candidate("claude:haiku", "low", 0.9, 1)] },
      signals: { risk_score: signal(12, 6) },
    });
    expect(proposeConfig(input)).toEqual([]);
  });

  it("leaves a decision pack's effort null", () => {
    const changes = proposeConfig(
      base({
        candidates: { risk_score: [candidate("codex:luna", null, 0.5, 1), candidate("claude:haiku", null, 0.9, 1)] },
        signals: { risk_score: signal(12, 6) },
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ pack: "risk_score", engine: { from: "codex:luna", to: "claude:haiku" }, effort: null });
  });

  it("drops a change declined within 30 days and keeps it after", () => {
    const input = base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.9, 1)] }, signals: { plan: signal(12, 6) } });
    const declined = (at: string) => [{ pack: "plan" as PackId, field: "engine" as const, to: "codex:sol", at }];
    expect(proposeConfig({ ...input, declined: declined("2026-10-20T00:00:00.000Z") })).toEqual([]);
    expect(proposeConfig({ ...input, declined: declined("2026-10-01T00:00:00.000Z") })).toHaveLength(1);
    // Another pack's decline, or another target, is not this one's.
    expect(proposeConfig({ ...input, declined: [{ pack: "triage", field: "engine", to: "codex:sol", at: "2026-11-15T00:00:00.000Z" }] })).toHaveLength(1);
    expect(proposeConfig({ ...input, declined: [{ pack: "plan", field: "effort", to: "low", at: "2026-11-15T00:00:00.000Z" }] })).toHaveLength(1);
  });

  it("returns at most three changes, step-ups first, then the largest saving", () => {
    const up = (pack: PackId) => [candidate("claude:opus", "high", 0.5, 1), candidate("claude:opus", "medium", 0.9, 1)];
    const down = (cost: number) => [candidate("claude:opus", "high", 0.9, 1), candidate("claude:opus", "low", 0.9, cost)];
    const changes = proposeConfig(
      base({
        candidates: { triage: down(0.6), plan: down(0.2), verifying: up("verifying"), reviewing: down(0.4) },
        signals: { triage: signal(20, 0), plan: signal(20, 0), verifying: signal(20, 10), reviewing: signal(20, 0) },
      }),
    );
    expect(changes.map((c) => c.pack)).toEqual(["verifying", "plan", "reviewing"]);
  });
});
