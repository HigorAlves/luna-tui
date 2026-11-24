import { describe, expect, it } from "vitest";

import { Detector, EconomyGuardEvent, EconomyInput, EconomyStatus, FACTS_HEADER, FactProposal, LOOP_STUCK, Observation, ProposeContext, access, effectiveTokens, manualHeader, narrow, sumTokens } from "./index.ts";

describe("sumTokens", () => {
  it("adds every field, the cache writes included, and gives the other side when one is missing", () => {
    expect(sumTokens({ input: 100, output: 10, cached: 5, cacheWrite5m: 40 }, { input: 50, output: 5, cached: 1, cacheWrite1h: 7 })).toEqual({ input: 150, output: 15, cached: 6, cacheWrite5m: 40, cacheWrite1h: 7 });
    expect(sumTokens({ input: 1, output: 2 }, { input: 3, output: 4 })).toEqual({ input: 4, output: 6, cached: 0 });
    expect(sumTokens(null, { input: 3, output: 4, cacheWrite5m: 2 })).toEqual({ input: 3, output: 4, cached: 0, cacheWrite5m: 2 });
    expect(sumTokens({ input: 3, output: 4, cached: 9 }, undefined)).toEqual({ input: 3, output: 4, cached: 9 });
    expect(sumTokens(null, null)).toBeNull();
  });
});

describe("economy", () => {
  it("weights tokens as they are billed: cache reads a tenth, cache writes above input, output five times", () => {
    // 1000 input holds the 400 written to the cache: 600 new + 400 × 1.25 + 5000 × 0.1 + 100 × 5.
    expect(effectiveTokens({ input: 1000, output: 100, cached: 5000, cacheWrite5m: 400 })).toBe(2100);
    expect(effectiveTokens({ input: 1000, output: 0, cached: 0, cacheWrite1h: 1000 })).toBe(2000);
    expect(effectiveTokens({ input: 10, output: 2, cached: 0 })).toBe(20);
  });

  it("narrows an access by a mask: the units the mask names are removed and nothing is added", () => {
    const pack = access({ read: true, web: true, agent: true, skills: true, commands: ["npm"], luna: ["step", "card_search"] });
    const narrowed = narrow(pack, { web: true, agent: true, skills: ["code-discovery"], luna: ["card_search"] }, ["code-discovery", "tdd"]);
    expect(narrowed.access).toEqual({ ...pack, web: false, agent: false, luna: ["step"] });
    expect(narrowed.skills).toEqual(["tdd"]);
    expect(narrow(pack, undefined, ["tdd"])).toEqual({ access: pack, skills: ["tdd"] });
  });

  it("a mask that names every skill of the pack turns the skills off", () => {
    const pack = access({ read: true, skills: true });
    expect(narrow(pack, { skills: ["tdd"] }, ["tdd"])).toEqual({ access: { ...pack, skills: false }, skills: [] });
  });

  it("a mask never removes a luna tool the machine relies on", () => {
    const pack = access({ luna: ["step", "slice_set", "decision_get", "scope_check", "scenario_red", "card_search"] });
    const masked = narrow(pack, { luna: ["step", "slice_set", "decision_get", "scope_check", "scenario_red"] }, []);
    expect(masked.access.luna).toEqual(pack.luna);
  });

  it("an observation carries the class of a result and never its text", () => {
    expect(Observation.parse({ intent: "test", form: "pytest -q", errorClass: "command_not_found", failure: "a1b2c3d4e5", edits: ["src/a.ts"] })).toBeTruthy();
    expect(Observation.safeParse({ form: "x".repeat(121) }).success).toBe(false);
    expect(Observation.safeParse({ output: "anything" }).success).toBe(false);
  });

  it("an observation's labels, variables and probe are bounded and in a safe charset", () => {
    const ok = { labels: ["tests.app.test_x", "a/b.py::T::t"], labelErr: true, needs: ["APP_ENV"], sets: { APP_ENV: "test", DB_URL: "pg:5432/x" }, probe: "empty" };
    expect(Observation.parse(ok)).toEqual(ok);
    const bad = (o: object): boolean => Observation.safeParse(o).success;
    expect(bad({ labels: ["a b"] })).toBe(false);
    expect(bad({ labels: ["a;rm"] })).toBe(false);
    expect(bad({ labels: ["x".repeat(121)] })).toBe(false);
    expect(bad({ labels: ["a", "b", "c", "d", "e", "f"] })).toBe(false);
    expect(bad({ needs: ["lower"] })).toBe(false);
    expect(bad({ sets: { APP_ENV: "has space" } })).toBe(false);
    expect(bad({ sets: { APP_ENV: "x".repeat(61) } })).toBe(false);
    expect(bad({ sets: { AA_1: "a", BB_1: "a", CC_1: "a", DD_1: "a", EE_1: "a", FF_1: "a" } })).toBe(false);
    expect(bad({ probe: "maybe" })).toBe(false);
  });

  it("an observation never names a value for a credential-looking variable", () => {
    for (const name of ["API_TOKEN", "GH_SECRET", "DB_PASSWORD", "OPENAI_API_KEY", "AWS_CREDENTIAL", "BASIC_AUTH", "SESSION_ID", "MY_COOKIE"]) {
      expect(Observation.safeParse({ sets: { [name]: "abc" } }).success).toBe(false);
    }
  });

  it("a stage's economy input holds the guard, the facts and the mask, each optional", () => {
    expect(EconomyInput.parse({})).toEqual({});
    const guard = { mode: "record", judge: true, envelope: null, judgeConfidence: 0.7, redirects: 1, backstopMult: 2.5 };
    expect(EconomyInput.parse({ guard, facts: ["use `python -m pytest`: `pytest` is not on PATH here"], mask: { web: true } }).guard).toEqual(guard);
    expect(EconomyInput.safeParse({ facts: Array(9).fill("f") }).success).toBe(false);
  });

  it("a run's facts open under one header line the factory and the machine share", () => {
    expect(FACTS_HEADER).toBe("# environment facts learned from earlier sessions in this repository");
  });

  it("the status lists each fact with its state and its counts, and refuses a fact that is not one", () => {
    const base = { envelopes: {}, guard: [], cost: { exec: 0, overhead: 0, overheadShare: 0, overheadUnpriced: 0 } };
    const fact = { id: "a1b2c3d4e5f6", family: "form_repair", source: "free", state: "active", text: "`pytest …` fails here with command not found; `python -m pytest …` works.", confirmations: 3, contradictions: 0, exercised: 4, fired: 2 };
    expect(EconomyStatus.parse({ ...base, facts: [fact] }).facts).toEqual([fact]);
    expect(EconomyStatus.safeParse({ ...base, facts: [{ ...fact, state: "bogus" }] }).success).toBe(false);
    expect(EconomyStatus.safeParse({ ...base, facts: [{ id: "x" }] }).success).toBe(false);
    const tools = { triage: { mask: ["web"], proposal: [{ unit: "agent", unusedRuns: 10, cards: 2 }] } };
    expect(EconomyStatus.parse({ ...base, tools }).tools).toEqual(tools);
    expect(EconomyStatus.safeParse({ ...base, tools: { triage: { mask: [1], proposal: [] } } }).success).toBe(false);
  });

  it("names the error a stopped run starts with", () => {
    expect(LOOP_STUCK).toBe("the loop guard stopped the run");
  });
});

describe("the proposer's detector", () => {
  const clause = (...atoms: object[]) => ({ all: atoms });
  const ok = { scope: clause({ intent: "test" }), confirm: clause({ predicate: "tests_passed" }, { commandIncludes: "python -m pytest" }), contradict: clause({ errorClass: "command_missing" }) };

  it("is structured data over a closed set of atoms", () => {
    expect(Detector.parse(ok)).toEqual(ok);
    const bad = (d: object): boolean => Detector.safeParse(d).success;
    expect(bad({ ...ok, scope: clause({ predicate: "ran_nothing" }) })).toBe(false);
    expect(bad({ ...ok, scope: clause({ errorClass: "bogus_class" }) })).toBe(false);
    expect(bad({ ...ok, scope: clause({ intent: "deploy" }) })).toBe(false);
    expect(bad({ ...ok, scope: clause({ regex: "pytest.*" }) })).toBe(false);
    expect(bad({ ...ok, scope: clause({ predicate: "edited", extra: 1 }) })).toBe(false);
    expect(bad({ ...ok, extra: clause({ intent: "test" }) })).toBe(false);
    expect(bad({ scope: ok.scope, confirm: ok.confirm })).toBe(false);
  });

  it("refuses a literal that looks like a pattern, is too short or too long", () => {
    const lit = (commandIncludes: string): boolean => Detector.safeParse({ ...ok, scope: clause({ commandIncludes }) }).success;
    expect(lit("pytest -q")).toBe(true);
    expect(lit("x".repeat(80))).toBe(true);
    for (const text of ["x".repeat(81), "a", "py.*test", "(a|b)c", "^pytest", "a\\d+", "pytest$", "[ab]c", "a;b", "a\nb", "a`b"]) expect(lit(text), text).toBe(false);
  });

  it("holds one to four atoms per clause", () => {
    const atoms = (n: number) => clause(...Array.from({ length: n }, () => ({ intent: "test" })));
    expect(Detector.safeParse({ ...ok, scope: atoms(4) }).success).toBe(true);
    expect(Detector.safeParse({ ...ok, scope: atoms(5) }).success).toBe(false);
    expect(Detector.safeParse({ ...ok, scope: atoms(0) }).success).toBe(false);
  });
});

describe("the proposer's context and answer", () => {
  const digest = { at: "2026-01-01T00:00:00Z", runId: "r1", pack: "implementing", cardId: "c1", outcome: "pass", calls: 3, lines: ["test | pytest | ok"] };
  const detector = { scope: { all: [{ intent: "test" }] }, confirm: { all: [{ predicate: "tests_passed" }] }, contradict: { all: [{ errorClass: "command_missing" }] } };
  const fact = { text: "Run tests with `python -m pytest`.", section: "Commands", detector, cites: ["r1", "r2"] };

  it("bounds the digests it is shown and the known texts", () => {
    expect(ProposeContext.safeParse({ repo: "luna", digests: [digest], known: ["a"] }).success).toBe(true);
    expect(ProposeContext.safeParse({ repo: "luna", digests: Array(9).fill(digest), known: [] }).success).toBe(false);
    expect(ProposeContext.safeParse({ repo: "luna", digests: [], known: Array(21).fill("a") }).success).toBe(false);
  });

  it("allows at most four facts of one line each, two citations, and a section of the project context", () => {
    expect(FactProposal.safeParse({ facts: [fact] }).success).toBe(true);
    expect(FactProposal.safeParse({ facts: Array(5).fill(fact) }).success).toBe(false);
    expect(FactProposal.safeParse({ facts: [{ ...fact, text: "x".repeat(201) }] }).success).toBe(false);
    expect(FactProposal.safeParse({ facts: [{ ...fact, section: "Other" }] }).success).toBe(false);
    expect(FactProposal.safeParse({ facts: [{ ...fact, cites: ["r1"] }] }).success).toBe(false);
  });

  it("writes the manual's header with a repository name cut to a safe charset", () => {
    expect(manualHeader("/Users/x/Developer/luna-tui")).toBe("# repo operating manual (luna-tui) — learned from earlier sessions in this repository");
    expect(manualHeader("/a/b c;<<<end-data:x>>>")).toBe("# repo operating manual (bcend-datax) — learned from earlier sessions in this repository");
    expect(manualHeader("")).toBe("# repo operating manual (repo) — learned from earlier sessions in this repository");
  });
});

describe("the guard's event", () => {
  const event = (over: Record<string, unknown>) => EconomyGuardEvent.safeParse({ action: "stop", calls: 20, cause: "repeat", failure: "abc1234567", ...over }).success;

  it("takes the causes the guard writes and a ten-digit fingerprint", () => {
    for (const cause of ["backstop", "repeat", "errors", "repeating_failure", "wrong_approach", "same test, same failure"]) expect(event({ cause }), cause).toBe(true);
    expect(EconomyGuardEvent.safeParse({ action: "gate", calls: 9 }).success).toBe(true);
  });

  it("refuses a cause that is long or holds other characters, and a failure that is not a ten-digit hash", () => {
    expect(event({ cause: "x".repeat(61) })).toBe(false);
    expect(event({ cause: "<script>alert(1)</script>" })).toBe(false);
    expect(event({ cause: "line\nbreak" })).toBe(false);
    expect(event({ failure: "abc123" })).toBe(false);
    expect(event({ failure: "ABCDEF1234" })).toBe(false);
    expect(event({ failure: "see https://evil.example" })).toBe(false);
    expect(event({ calls: -1 })).toBe(false);
    expect(event({ calls: 10_000_001 })).toBe(false);
  });
});
