import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Calibration } from "./calibration.ts";
import type { Scorecard } from "./grade.ts";
import { buildDefaultsFile, loadBaselines, proposeDefaults, renderScorecard, wilson, PINNED } from "./scorecard.ts";

/** A baseline: `cases` graded cases costing `costUsd` in all, calibration as given over the defaults below. */
const card = (pack: string, engine: string, calibration: Partial<Calibration>, over: { costUsd?: number | null; at?: string } = {}): Scorecard =>
  ({
    schema: 1, pack, engine, model: "m", judge: null, at: over.at ?? "2026-11-10T10:00:00.000Z",
    summary: { cases: 4, passed: 3, passRate: 0.75, meanJudgeScore: null, meanTurns: 1, meanDurationMs: 2000, costUsd: over.costUsd === undefined ? 0.04 : over.costUsd, judgeCostUsd: null, calibration: { n: 8, labelled: 8, acted: 6, accuracy: 0.75, actedOnAccuracy: 0.75, coverage: 0.75, brier: 0.1, ece: 0.1, meanConfidence: 0.8, overconfident: 0, ...calibration } },
    cases: [1000, 3000, 2000, 2000].map((durationMs, i) => ({ id: `c${i}`, pass: true, schema: { check: "s", pass: true, detail: null }, checks: [], judge: null, turns: 1, durationMs, costUsd: 0.01, model: "m" })),
  }) as unknown as Scorecard;

const current = { default: "jev", fallback: ["claude:haiku"] } as const;

describe("proposeDefaults", () => {
  it("keeps the current default and says unmeasured when fewer than two engines were measured", () => {
    const one = proposeDefaults("risk_score", [card("risk_score", "claude:haiku", {})], current);
    expect(one).toMatchObject({ default: "jev", measured: false });
    expect(one.reason).toMatch(/^unmeasured: 1 engine measured/);
    expect(proposeDefaults("risk_score", [], current).reason).toMatch(/^unmeasured: 0 engines/);
  });

  it("takes the highest acted-on accuracy among engines with coverage >= 0.6 and n >= 4", () => {
    const out = proposeDefaults("risk_score", [
      card("risk_score", "claude:haiku", { actedOnAccuracy: 0.8, coverage: 0.7 }),
      card("risk_score", "codex:luna", { actedOnAccuracy: 0.95, coverage: 0.5 }), // best, but acts on too little
      card("risk_score", "jev", { actedOnAccuracy: 0.99, coverage: 0.9, n: 3 }), // best, but only three cases
    ], current);
    expect(out).toMatchObject({ default: "claude:haiku", measured: true, fallback: ["codex:luna"] });
    expect(out.reason).toContain("acted-on accuracy 0.80");
  });

  it("sends a tie within two points to the cheaper engine", () => {
    const cards = [
      card("risk_score", "claude:haiku", { actedOnAccuracy: 0.9 }, { costUsd: 0.04 }),
      card("risk_score", "codex:luna", { actedOnAccuracy: 0.91 }, { costUsd: 0.02 }),
    ];
    expect(proposeDefaults("risk_score", cards, current).default).toBe("codex:luna");
    // 0.9 vs 0.93: three points apart is no tie, the better one wins whatever it costs.
    expect(proposeDefaults("risk_score", [cards[0]!, card("risk_score", "codex:luna", { actedOnAccuracy: 0.93 }, { costUsd: 0.2 })], current).default).toBe("codex:luna");
    expect(proposeDefaults("risk_score", [card("risk_score", "claude:haiku", { actedOnAccuracy: 0.96 }, { costUsd: 0.04 }), card("risk_score", "codex:luna", { actedOnAccuracy: 0.93 }, { costUsd: 0.001 })], current).default).toBe("claude:haiku");
  });

  it("gives a tie to Jev, by far the cheapest engine, and keeps a better engine when Jev is behind or does not qualify", () => {
    const haiku = card("risk_score", "claude:haiku", { actedOnAccuracy: 0.85 }, { costUsd: 0.04 });
    // Level, or within the two points of a tie: Jev, with Claude as the engine to fall back on.
    expect(proposeDefaults("risk_score", [card("risk_score", "jev", { actedOnAccuracy: 0.85 }, { costUsd: 0.001 }), haiku], current)).toMatchObject({ default: "jev", fallback: ["claude:haiku"] });
    expect(proposeDefaults("risk_score", [card("risk_score", "jev", { actedOnAccuracy: 0.84 }, { costUsd: 0.001 }), haiku], current).default).toBe("jev");
    // Jev wins the tie even when its cost was not recorded: the preference is for the engine, not for a number in a file.
    expect(proposeDefaults("risk_score", [card("risk_score", "jev", { actedOnAccuracy: 0.85 }, { costUsd: null }), haiku], current).default).toBe("jev");
    // Five points behind is no tie: accuracy comes first.
    expect(proposeDefaults("risk_score", [card("risk_score", "jev", { actedOnAccuracy: 0.8 }, { costUsd: 0.001 }), haiku], current).default).toBe("claude:haiku");
    // Jev that acts on too few cases does not qualify.
    expect(proposeDefaults("risk_score", [card("risk_score", "jev", { actedOnAccuracy: 0.99, coverage: 0.5 }, { costUsd: 0.001 }), haiku], current).default).toBe("claude:haiku");
  });

  it("gives the default to an engine that acted on every case and was right on every one, over an engine that only ties on what it acted on", () => {
    const perfect = card("split_check", "codex:luna", { actedOnAccuracy: 1, accuracy: 1, coverage: 1 }, { costUsd: 0.2 });
    const jevHalf = card("split_check", "jev", { actedOnAccuracy: 1, accuracy: 0.75, coverage: 0.6 }, { costUsd: 0.001 });
    const haikuPart = card("split_check", "claude:haiku", { actedOnAccuracy: 1, accuracy: 1, coverage: 0.6 }, { costUsd: 0.01 });
    const chosen = proposeDefaults("split_check", [perfect, jevHalf, haikuPart], current);
    expect(chosen.default).toBe("codex:luna");
    expect(chosen.reason).toMatch(/acted on every case and was right on every one/);
    // Two perfect engines: Jev among them still wins, else the cheaper.
    const jevPerfect = card("split_check", "jev", { actedOnAccuracy: 1, accuracy: 1, coverage: 1 }, { costUsd: 0.001 });
    expect(proposeDefaults("split_check", [perfect, jevPerfect], current).default).toBe("jev");
    const haikuPerfect = card("split_check", "claude:haiku", { actedOnAccuracy: 1, accuracy: 1, coverage: 1 }, { costUsd: 0.01 });
    expect(proposeDefaults("split_check", [perfect, haikuPerfect, jevHalf], current).default).toBe("claude:haiku");
    // Nobody perfect: the tie still goes to Jev.
    const lunaNear = card("split_check", "codex:luna", { actedOnAccuracy: 1, accuracy: 1, coverage: 0.9 }, { costUsd: 0.2 });
    expect(proposeDefaults("split_check", [lunaNear, jevHalf], current).default).toBe("jev");
  });

  it("keeps a pack the owner pinned on its engine whatever the numbers say, and says so with the numbers beside it", () => {
    const perfect = card("worth_learning", "codex:luna", { actedOnAccuracy: 1, accuracy: 1, coverage: 1 }, { costUsd: 0.2 });
    const jevPart = card("worth_learning", "jev", { actedOnAccuracy: 1, accuracy: 0.8, coverage: 0.67 }, { costUsd: 0.001 });
    const chosen = proposeDefaults("worth_learning", [perfect, jevPart], current);
    expect(chosen.default).toBe("jev");
    expect(chosen.reason).toMatch(/pinned by the owner/);
    expect(chosen.scorecard["codex:luna"]!.coverage).toBe(1);
    expect(Object.keys(PINNED).sort()).toEqual(["ci_failure_class", "conversation_relation", "escalation_reason", "fix_scope", "worth_learning"]);
    // A pack that is not pinned follows the rule.
    expect(proposeDefaults("split_check", [card("split_check", "codex:luna", { actedOnAccuracy: 1, coverage: 1 }), card("split_check", "jev", { actedOnAccuracy: 1, coverage: 0.6 })], current).default).toBe("codex:luna");
  });

  it("carries the numbers behind the choice and when they were measured", () => {
    const out = proposeDefaults("risk_score", [card("risk_score", "claude:haiku", {}, { at: "2026-11-09T08:00:00.000Z" }), card("risk_score", "codex:luna", {}, { at: "2026-11-11T08:00:00.000Z" })], current);
    expect(out.measuredAt).toBe("2026-11-11");
    expect(out.scorecard).toMatchObject({ "claude:haiku": { n: 8, actedOnAccuracy: 0.75, coverage: 0.75 }, "codex:luna": { n: 8 } });
  });
});

describe("the scorecard", () => {
  it("reads every baseline of a decision pack, one row per pack and engine, with the cost per case and the median latency", () => {
    const evals = mkdtempSync(join(tmpdir(), "scorecard-"));
    for (const [engine, c] of [["claude-haiku", card("risk_score", "claude:haiku", { actedOnAccuracy: 0.9 })], ["codex-luna", card("risk_score", "codex:luna", { actedOnAccuracy: 0.8 })], ["claude-haiku-x", card("triage", "claude:haiku", {})]] as const) {
      mkdirSync(join(evals, "baselines", engine), { recursive: true });
      writeFileSync(join(evals, "baselines", engine, `${c.pack}.json`), JSON.stringify(c));
    }
    const cards = loadBaselines(evals);
    expect(cards.map((c) => `${c.pack} ${c.engine}`).sort()).toEqual(["risk_score claude:haiku", "risk_score codex:luna"]);
    const md = renderScorecard(cards, { risk_score: proposeDefaults("risk_score", cards, current) }, new Date("2026-11-12T00:00:00Z"));
    // Median of 1000, 2000, 2000, 3000 ms is 2.0 s; $0.04 over 4 cases is $0.0100 a case.
    expect(md).toContain("| risk_score | claude:haiku | 8 | 75% | 90% (57-98) | 75% | 0.100 | 0.100 | $0.0100 | 2.0s | 2026-11-10 |");
    expect(md).toMatch(/\| risk_score \| claude:haiku \| .*\n\| risk_score \| codex:luna \|/);
    expect(md).toContain("claude:haiku");
    expect(md).toMatch(/risk_score.*claude:haiku.*acted-on accuracy 0\.90/);
    expect(md).toContain("Generated 2026-11-12");
  });

  it("marks a pack with fewer than two engines unmeasured, keeping its default", () => {
    const md = renderScorecard([card("risk_score", "claude:haiku", {})], { risk_score: proposeDefaults("risk_score", [card("risk_score", "claude:haiku", {})], current) }, new Date("2026-11-12T00:00:00Z"));
    expect(md).toMatch(/\| risk_score \| jev \| unmeasured/);
  });
});

describe("buildDefaultsFile", () => {
  const unmeasuredEntry = { default: "jev", fallback: ["claude:haiku"], reason: "unmeasured: RFC 0005 wave 0 default", measuredAt: "2026-11-04" };
  const cards = [card("risk_score", "claude:haiku", { actedOnAccuracy: 0.9 }), card("risk_score", "codex:luna", { actedOnAccuracy: 0.7 })];

  it("takes the proposal of a measured pack, with its numbers, and keeps the entry of an unmeasured one", () => {
    const file = buildDefaultsFile({ risk_score: unmeasuredEntry, event_class: unmeasuredEntry }, { risk_score: proposeDefaults("risk_score", cards, current), event_class: proposeDefaults("event_class", [], current) });
    expect(file.event_class).toEqual(unmeasuredEntry);
    expect(file.risk_score).toMatchObject({ default: "claude:haiku", fallback: ["codex:luna"], measuredAt: "2026-11-10", reason: expect.stringContaining("acted-on accuracy 0.90"), scorecard: { "claude:haiku": { n: 8 } } });
  });

  it("refuses to write an entry the contracts would reject", () => {
    expect(() => buildDefaultsFile({}, { risk_score: { ...proposeDefaults("risk_score", cards, current), default: "claude:opus" as never } })).toThrow();
  });
});

describe("a default moves only on enough cases", () => {
  it("keeps the current default and says why when the winner was measured on fewer than eight cases or six labelled", () => {
    const few = [card("risk_score", "claude:haiku", { actedOnAccuracy: 0.95, coverage: 0.9, n: 7, labelled: 7 }), card("risk_score", "codex:luna", { actedOnAccuracy: 0.6, coverage: 0.9 })];
    const out = proposeDefaults("risk_score", few, current);
    expect(out).toMatchObject({ default: "jev", measured: false });
    expect(out.reason).toBe("kept: claude:haiku won on n 7, 8 are needed to move a default");
    const unlabelled = [card("risk_score", "claude:haiku", { actedOnAccuracy: 0.95, coverage: 0.9, labelled: 5 }), card("risk_score", "codex:luna", { actedOnAccuracy: 0.6, coverage: 0.9 })];
    expect(proposeDefaults("risk_score", unlabelled, current).reason).toBe("kept: claude:haiku won on 5 labelled, 6 are needed to move a default");
  });

  it("never un-pins: a pinned pack stays on its engine and shows the pin beside the numbers, whatever the cases", () => {
    const out = proposeDefaults("fix_scope", [card("fix_scope", "claude:haiku", { actedOnAccuracy: 1, coverage: 1, n: 3, labelled: 3 }), card("fix_scope", "jev", { actedOnAccuracy: 0.5, coverage: 0.7 })], current);
    expect(out).toMatchObject({ default: "jev", measured: true });
    expect(out.reason).toContain("pinned by the owner");
  });
});

describe("a pack read answer by answer", () => {
  const answers = (over: Record<string, unknown>) => ({ n: 40, labelled: 30, acted: 24, accuracy: 0.8, actedOnAccuracy: 0.9, coverage: 0.7, brier: 0.1, ece: 0.1, meanConfidence: 0.8, overconfident: 0, ...over });
  const answerCard = (engine: string, block: Record<string, unknown> | null, over: Partial<Calibration> = {}) => {
    const c = card("ticket_assess", engine, over) as unknown as { summary: Record<string, unknown> };
    if (block) c.summary.answers = block;
    return c as unknown as Scorecard;
  };

  it("reads the rule on the pool of answers: coverage 0.6, 20 labelled answers, the highest acted-on answer accuracy, and says per answer", () => {
    const out = proposeDefaults("ticket_assess", [
      answerCard("claude:haiku", answers({ actedOnAccuracy: 0.92 })),
      answerCard("codex:luna", answers({ actedOnAccuracy: 0.97, coverage: 0.5 })),
    ], current);
    expect(out).toMatchObject({ default: "claude:haiku", measured: true });
    expect(out.reason).toContain("per answer");
    const thin = proposeDefaults("ticket_assess", [answerCard("claude:haiku", answers({ labelled: 19 })), answerCard("codex:luna", answers({ labelled: 19 }))], current);
    expect(thin).toMatchObject({ default: "jev", measured: false });
  });

  it("does not qualify a baseline from before the per-answer measure, and says so", () => {
    const out = proposeDefaults("ticket_assess", [answerCard("claude:haiku", null), answerCard("codex:luna", null)], current);
    expect(out).toMatchObject({ default: "jev", measured: false });
    expect(out.reason).toContain("unmeasured: run before the per-answer measure");
  });

  it("prints a Per answer section with a row per pack, engine and question", () => {
    const block = { ...answers({}), };
    const c = answerCard("claude:haiku", block);
    (c.summary as unknown as Record<string, unknown>).perQuestion = { who: { n: 8, labelled: 6, acted: 5, accuracy: 0.83, actedOnAccuracy: 1, coverage: 0.75, brier: 0.12, ece: 0.1, meanConfidence: 0.8, overconfident: 0 }, what: { n: 8, labelled: 6, acted: 4, accuracy: 0.5, actedOnAccuracy: 0.5, coverage: 0.5, brier: 0.3, ece: 0.2, meanConfidence: 0.7, overconfident: 1 } };
    const md = renderScorecard([c], {}, new Date("2026-11-12T00:00:00Z"));
    expect(md).toContain("## Per answer");
    expect(md).toContain("| ticket_assess | claude:haiku | who | 6 | 83% | 100% | 75% | 0.120 |");
    expect(md).toContain("| ticket_assess | claude:haiku | what | 6 | 50% | 50% | 50% | 0.300 |");
  });

  it("leaves a pack out of the defaults file when asked (--except), exactly as it was", () => {
    const entry = { default: "jev", fallback: ["claude:haiku"], reason: "kept by hand", measuredAt: "2026-11-01" };
    const cards = [card("risk_score", "claude:haiku", { actedOnAccuracy: 0.9 }), card("risk_score", "codex:luna", { actedOnAccuracy: 0.7 })];
    const file = buildDefaultsFile({ risk_score: entry }, { risk_score: proposeDefaults("risk_score", cards, current) }, { except: ["risk_score"] });
    expect(file.risk_score).toEqual(entry);
  });
});

describe("the interval beside acted-on accuracy", () => {
  it("is the 90% Wilson interval: six right of six reads 69 to 100, so eight cases are seen to say little", () => {
    expect(wilson(1, 6)).toEqual([69, 100]);
    expect(wilson(0.9, 6)).toEqual([57, 98]);
  });
});
