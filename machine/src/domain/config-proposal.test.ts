import type { Effort, EngineId, PackId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { CALM, type Candidate, type ConfigChange, CHEAPER, DECLINE_DAYS, GAIN, MAX_CHANGES, MIN_CASES, MIN_RUNS, type ProposalInput, type RepoSignal, TOLERANCE, TROUBLE, proposeConfig, proposalSkips, renderProposal } from "./config-proposal.ts";

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

describe("the engine a pack ran on", () => {
  const withEngines = (engines: RepoSignal["engines"], runs = 10, escalations = 4): RepoSignal => ({ runs, escalations, stuck: 0, costUsd: 1, engines });

  it("is the baseline when it differs from the default", () => {
    // plan defaults to claude:opus; the repo ran it on codex:sol, so codex:sol is the current pair.
    const input = base({
      candidates: { plan: [candidate("claude:opus", "high", 0.9, 1), candidate("codex:sol", "high", 0.5, 1), candidate("claude:opus", "medium", 0.8, 1)] },
      signals: { plan: withEngines({ "codex:sol": 10 }) },
    });
    const changes = proposeConfig(input);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ engine: { from: "codex:sol", to: "claude:opus" }, effort: null });
    expect(changes[0]!.evidence.current).toMatchObject({ engine: "codex:sol", quality: 0.5 });
  });

  it("wins over the configured engine too", () => {
    const input = base({
      current: { engines: { plan: "claude:opus" }, effort: {} },
      candidates: { plan: [candidate("claude:opus", "high", 0.55, 1), candidate("codex:sol", "high", 0.5, 1), candidate("codex:sol", "medium", 0.8, 1)] },
      signals: { plan: withEngines({ "codex:sol": 9, "claude:opus": 1 }) },
    });
    expect(proposeConfig(input)[0]).toMatchObject({ engine: null, effort: { from: "high", to: "medium" } });
  });

  it("keeps the configured baseline when it ran at least 80% of the runs", () => {
    const input = base({
      candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.9, 1)] },
      signals: { plan: withEngines({ "claude:opus": 8, "codex:sol": 2 }) },
    });
    expect(proposeConfig(input)[0]).toMatchObject({ engine: { from: "claude:opus", to: "codex:sol" } });
  });

  it("skips a pack when no engine ran 80% of its runs, and says why", () => {
    const input = base({
      candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.9, 1)] },
      signals: { plan: withEngines({ "claude:opus": 7, "codex:sol": 3 }) },
    });
    expect(proposeConfig(input)).toEqual([]);
    expect(proposalSkips(input)).toEqual([{ pack: "plan", reason: "plan ran on mixed engines: claude:opus 7 of 10 runs, under 80%" }]);
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

  it("says how many escalations were a stuck loop", () => {
    const changes = proposeConfig(base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.8, 1)] }, signals: { plan: signal(10, 3, 2) } }));
    expect(changes[0]!.why).toBe("plan escalated 3 of 10 runs (2 stuck in a loop); codex:sol at high passed 0.80 vs 0.50");
  });

  it("does not count a stuck loop twice: the machine escalates every one", () => {
    // 2 escalations of 10, both loop-guard stops: a trouble rate of 0.2, neither in trouble nor calm.
    const changes = proposeConfig(base({ candidates: { plan: [candidate("claude:opus", "high", 0.5, 1), candidate("codex:sol", "high", 0.8, 1)] }, signals: { plan: signal(10, 2, 2) } }));
    expect(changes).toEqual([]);
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

describe("renderProposal", () => {
  const change = (pack: PackId, over: Partial<ConfigChange>): ConfigChange => ({ pack, engine: null, effort: null, why: "", evidence: {} as ConfigChange["evidence"], ...over });
  const FILE = [
    "# the repo's checks",
    "checks:",
    "  - { name: unit, run: pnpm test, timeout: 5 }",
    "",
    "engines:",
    "  plan: claude:opus # keep for now",
    "learning:",
    "  records: false",
    "economy:",
    "  loop_guard: off",
    "graph:",
    "  stale_commits: 7",
    "plan:",
    "  sla:",
    "    escalate_days: 3",
    "",
  ].join("\n");

  it("keeps comments, unknown keys and key order when it changes one engine and one effort", () => {
    const out = renderProposal(FILE, [change("plan", { engine: { from: "claude:opus", to: "codex:sol" } }), change("triage", { effort: { from: "high", to: "medium" } })]);
    expect(out).toContain("# the repo's checks");
    expect(out).toContain("# keep for now");
    expect(out).toContain("plan: codex:sol");
    expect(out).toMatch(/effort:\n {2}triage: medium/);
    expect(out).toContain("learning:\n  records: false");
    expect(out).toContain("economy:\n  loop_guard: off");
    expect(out).toContain("graph:\n  stale_commits: 7");
    expect(out).toContain("escalate_days: 3");
    expect(out.indexOf("checks:")).toBeLessThan(out.indexOf("engines:"));
    expect(out.indexOf("economy:")).toBeLessThan(out.indexOf("graph:"));
  });

  it("adds an engines section to a file that has none", () => {
    const out = renderProposal("# top\nchecks:\n  - { name: unit, run: pnpm test, timeout: 5 }\ngraph:\n  stale_commits: 7\n", [change("plan", { engine: { from: "claude:opus", to: "codex:sol" } })]);
    expect(out).toContain("# top");
    expect(out).toMatch(/engines:\n {2}plan: codex:sol/);
    expect(out).toContain("graph:\n  stale_commits: 7");
  });

  it("starts from nothing for an empty file", () => {
    expect(renderProposal("", [change("plan", { engine: { from: "claude:opus", to: "codex:sol" } })])).toMatch(/engines:\n {2}plan: codex:sol/);
  });
});
