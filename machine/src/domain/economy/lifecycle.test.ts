import { describe, expect, it } from "vitest";

import { type Evidence, evidenceOf, factId } from "./envfacts.ts";
import { FIRE_GATE, FIRE_MIN_CARDS, FIRE_MIN_N, GAMMA, K_PROMOTE, LAMBDA, SCORE_FLOOR, dropFact, type FactRecord, fires, foldFacts } from "./lifecycle.ts";
import type { ObservedCall } from "./observe-run.ts";

const evidence = (over: Partial<Evidence> = {}): Evidence => ({ family: "env_value", key: "APP_ENV", text: "Code that imports the project needs `APP_ENV` set here: `APP_ENV=test` works.", confirms: true, contradicts: false, exercised: true, fired: true, ...over });
const run = (n: number) => ({ runId: `r${n}`, cardId: `c${n}` });
/** Folds each evidence list as one run, in order. */
const fold = (lists: Evidence[][], from: FactRecord[] = []) => lists.reduce((facts, list, i) => foldFacts(facts, list, run(i + 1)), from);
const confirm = evidence();
const contradict = evidence({ text: "", confirms: false, contradicts: true });
const quiet = evidence({ text: "", confirms: false, exercised: false, fired: false });
const record = (over: Partial<FactRecord> = {}): FactRecord => ({
  id: factId("env_value", "APP_ENV"), family: "env_value", source: "free", key: "APP_ENV", text: "t", state: "active", confirmations: 5, contradictions: 0, score: 3, exercised: 6, fired: 6, cards: ["c1", "c2"], firstRun: "r0", lastRun: "r0", streak: 0, ...over,
});

describe("the lifecycle's constants", () => {
  it("are upstream's validated replay constants", () => {
    expect([K_PROMOTE, GAMMA, LAMBDA, SCORE_FLOOR, FIRE_GATE, FIRE_MIN_N, FIRE_MIN_CARDS]).toEqual([3, 0.8, 5, 0, 0.4, 4, 2]);
  });
});

describe("foldFacts: formation", () => {
  it("makes a candidate of a new fact, with a stable id, and records the run and the card", () => {
    const [fact] = fold([[confirm]]);
    expect(fact).toEqual({ id: factId("env_value", "APP_ENV"), family: "env_value", source: "free", key: "APP_ENV", text: confirm.text, state: "candidate", confirmations: 1, contradictions: 0, score: 1, exercised: 1, fired: 1, cards: ["c1"], firstRun: "r1", lastRun: "r1", streak: 0 });
  });

  it("makes an active form-repair fact of three runs where pytest is missing and python -m pytest works", () => {
    const calls: ObservedCall[] = [
      { intent: "test", form: "pytest", errorClass: "command_missing", ok: false },
      { intent: "test", form: "python -m pytest", testsRan: true, ok: true },
    ];
    let facts: FactRecord[] = [];
    const states: string[] = [];
    for (let n = 1; n <= 3; n++) {
      facts = foldFacts(facts, evidenceOf(calls, { known: facts }), run(n));
      states.push(facts.find((f) => f.family === "form_repair")?.state as string);
    }
    expect(states).toEqual(["candidate", "candidate", "active"]);
    const fact = facts.find((f) => f.family === "form_repair");
    expect(fact).toMatchObject({ key: "test:pytest", text: "`pytest …` fails here with command not found; `python -m pytest …` works.", confirmations: 3, exercised: 3, fired: 3, cards: ["c1", "c2", "c3"], firstRun: "r1", lastRun: "r3" });
  });

  it("does not create a fact from evidence that states nothing", () => {
    expect(fold([[quiet]])).toEqual([]);
  });

  it("keeps a fact's text when a run does not state it, and takes the newest text when it does", () => {
    const facts = fold([[confirm], [evidence({ text: "" })], [evidence({ text: "newer" })]]);
    expect(facts[0]?.text).toBe("newer");
    expect(fold([[confirm], [evidence({ text: "" })]])[0]?.text).toBe(confirm.text);
  });

  it("lists a card once however many of its runs confirm", () => {
    const facts = foldFacts(foldFacts([], [confirm], { runId: "r1", cardId: "c1" }), [confirm], { runId: "r2", cardId: "c1" });
    expect(facts[0]?.cards).toEqual(["c1"]);
  });
});

describe("foldFacts: the score", () => {
  it("decays by 0.8 on each run, for every fact", () => {
    const [a] = fold([[confirm], [confirm]]);
    expect(a?.score).toBeCloseTo(1.8, 10);
    expect(fold([[confirm], [confirm], []])[0]?.score).toBeCloseTo(1.44, 10);
    expect(fold([[confirm], [quiet]])[0]?.score).toBeCloseTo(0.8, 10);
  });

  it("weighs a contradiction five times a confirmation", () => {
    const [fact] = fold([[confirm], [contradict]]);
    expect(fact?.score).toBeCloseTo(0.8 - 5, 10);
    expect(fact?.contradictions).toBe(1);
  });

  it("retires an active fact on a contradiction however long its record, since five confirmations decayed never outweigh it", () => {
    const facts = fold([...Array.from({ length: 30 }, () => [confirm]), [contradict]]);
    expect(facts[0]?.state).toBe("retired");
  });

  it("retires an active fact by its score, not by a quiet run", () => {
    expect(foldFacts([record({ state: "active", score: 0.2 })], [quiet], run(1))[0]?.state).toBe("active");
    expect(foldFacts([record({ state: "active", score: -0.1 })], [], run(1))[0]?.state).toBe("retired");
  });

  it("leaves a candidate a contradiction touched a candidate, unless it is high-stakes", () => {
    expect(fold([[confirm], [contradict]])[0]?.state).toBe("candidate");
    const boundary = evidence({ family: "boundary", key: "fetch_remote" });
    const facts = fold([[boundary], [{ ...boundary, text: "", confirms: false, contradicts: true }]]);
    expect(facts[0]).toMatchObject({ family: "boundary", state: "retired" });
  });

  it("retires a high-stakes active fact on one contradiction", () => {
    const tool = evidence({ family: "absent_tool", key: "ruff", text: "`ruff …` fails" });
    const facts = fold([[tool], [tool], [tool], [{ ...tool, text: "", confirms: false, contradicts: true }]]);
    expect(facts[0]?.state).toBe("retired");
    expect(foldFacts([record({ family: "absent_tool", key: "ruff", id: factId("absent_tool", "ruff"), state: "active", score: 20 })], [{ ...tool, confirms: false, contradicts: true }], run(1))[0]?.state).toBe("retired");
  });

  it("does not retire a candidate that the same run promotes", () => {
    const boundary = evidence({ family: "boundary", key: "fetch_remote" });
    const both = { ...boundary, confirms: false, contradicts: true };
    const facts = foldFacts([record({ family: "boundary", key: "fetch_remote", id: factId("boundary", "fetch_remote"), state: "candidate", confirmations: 3, score: 2 })], [both], run(9));
    expect(facts[0]?.state).toBe("active");
  });

  it("asks a form-repair fact for two contradictions in a row before it counts one", () => {
    const repair = (over: Partial<Evidence>) => evidence({ family: "form_repair", key: "test:pytest", text: "x", ...over });
    const against = repair({ text: "", confirms: false, contradicts: true });
    const active = [record({ family: "form_repair", key: "test:pytest", id: factId("form_repair", "test:pytest") })];
    const once = foldFacts(active, [against], run(1));
    expect(once[0]).toMatchObject({ state: "active", contradictions: 0, streak: 1 });
    expect(foldFacts(once, [against], run(2))[0]).toMatchObject({ state: "retired", contradictions: 1 });
    const broken = foldFacts(foldFacts(once, [repair({})], run(2)), [against], run(3));
    expect(broken[0]).toMatchObject({ state: "active", streak: 1 });
  });

  it("does not move the streak on a run that did not use the fact", () => {
    const active = [record({ family: "form_repair", key: "test:pytest", id: factId("form_repair", "test:pytest"), streak: 1 })];
    const idle = evidence({ family: "form_repair", key: "test:pytest", text: "", confirms: false, exercised: false, fired: false });
    expect(foldFacts(active, [idle], run(1))[0]?.streak).toBe(1);
  });
});

describe("fires", () => {
  const withRuns = (exercised: number, fired: number) => record({ exercised, fired });

  it("needs four exercising runs, 40% of them fired", () => {
    expect(fires(withRuns(3, 3))).toBe(false);
    expect(fires(withRuns(4, 2))).toBe(true);
    expect(fires(withRuns(5, 1))).toBe(false);
    expect(fires(withRuns(5, 2))).toBe(true);
    expect(fires(withRuns(4, 1))).toBe(false);
  });

  it("needs two distinct cards among those that confirmed it, so one card's retries cannot get a fact stated", () => {
    expect(fires(record({ cards: [] }))).toBe(false);
    expect(fires(record({ cards: ["c1"] }))).toBe(false);
    expect(fires(record({ cards: ["c1", "c1"] }))).toBe(false);
    expect(fires(record({ cards: ["c1", ""] }))).toBe(false);
    expect(fires(record({ cards: ["", ""] }))).toBe(false);
    expect(fires(record({ cards: ["c1", "c2"] }))).toBe(true);
  });

  it("is for an active free fact only", () => {
    expect(fires(record({ state: "candidate" }))).toBe(false);
    expect(fires(record({ state: "retired" }))).toBe(false);
    expect(fires(record({ state: "dropped" }))).toBe(false);
    expect(fires(record({ state: "promoted" }))).toBe(false);
    expect(fires(record({ source: "proposed" }))).toBe(false);
  });

  it("follows the folded counts: three exercising runs do not inject, four with two fired do, five with one fired do not", () => {
    const run3 = fold([[confirm], [confirm], [confirm]]);
    expect(run3[0]?.state).toBe("active");
    expect(fires(run3[0] as FactRecord)).toBe(false);
    const noFire = evidence({ fired: false });
    expect(fires(fold([[confirm], [confirm], [noFire], [noFire]])[0] as FactRecord)).toBe(true);
    expect(fires(fold([[confirm], [noFire], [noFire], [noFire], [noFire]])[0] as FactRecord)).toBe(false);
  });
});

describe("terminal states", () => {
  it("never leaves retired, whatever a later run says", () => {
    const facts = fold([[confirm], [confirm], [confirm], [contradict], [confirm], [confirm], [confirm]]);
    expect(facts[0]?.state).toBe("retired");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.confirmations).toBe(3);
  });

  it("keeps a retired fact's counts and score where they were", () => {
    const retired = record({ state: "retired", score: -4 });
    expect(foldFacts([retired], [confirm], run(1))).toEqual([retired]);
  });

  it("never brings a dropped fact back, nor makes it again from a run that finds its key", () => {
    const dropped = record({ state: "dropped" });
    expect(foldFacts([dropped], [confirm, confirm], run(1))).toEqual([dropped]);
    expect(fold([[confirm]], [dropped])).toEqual([dropped]);
  });

  it("leaves a promoted fact and a proposed one to the proposer", () => {
    const promoted = record({ state: "promoted" });
    const proposed = record({ source: "proposed", id: "p1", key: "other", state: "candidate", confirmations: 1 });
    expect(foldFacts([promoted, proposed], [], run(1))).toEqual([promoted, proposed]);
  });
});

describe("dropFact", () => {
  it("drops a fact by id, and a dropped key stays dropped", () => {
    const facts = [record()];
    const out = dropFact(facts, facts[0]?.id as string);
    expect(out.found).toBe(true);
    expect(out.facts[0]?.state).toBe("dropped");
    expect(fires(out.facts[0] as FactRecord)).toBe(false);
    expect(foldFacts(out.facts, [confirm], run(1))[0]?.state).toBe("dropped");
  });

  it("is not found for an id nobody holds, and changes nothing", () => {
    const facts = [record()];
    expect(dropFact(facts, "nope")).toEqual({ facts, found: false });
  });
});
