// The build watch follows an implementing run's /out while the container runs: a slice turned
// committed is pushed as it lands, so a killed container never loses a green slice.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CheckContext } from "@hardness/contracts";

import { type Learned, tagged } from "../decision-truth.ts";
import { type Decide, MAX_CARD_SEARCHES, MAX_MAILBOX_BYTES, MAX_REDS_PER_SLICE, MAX_SCOPE_REQUESTS, NOTE_TAIL, buildChecks, buildWatch, cardSearchAnswers, judgeRedCheck, readMailbox, writeMailbox } from "./build-watch.ts";

const ledger = (slices: Array<{ id: number; status: string; commit?: string | null }>) =>
  JSON.stringify({ schema: 1, slices: slices.map((s) => ({ id: s.id, title: `slice ${s.id}`, status: s.status, commit: s.commit ?? null })) });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("buildWatch", () => {
  it("calls onCommitted once per slice that became committed, and never again for the same slice", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-watch-"));
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 1, status: "red" }]));
    const committed: number[] = [];
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async (slice) => void committed.push(slice.id) });
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 1, status: "committed", commit: "abc" }]));
    await settle(60);
    expect(committed).toEqual([1]);
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 1, status: "committed", commit: "abc" }, { id: 2, status: "committed", commit: "def" }]));
    await settle(60);
    expect(committed).toEqual([1, 2]);
    writeFileSync(join(out, "ledger.json"), "{ not json");
    await settle(30);
    await watch.stop();
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 3, status: "committed", commit: "ghi" }]));
    await settle(30);
    expect(committed).toEqual([1, 2]);
  });
});

const redLedger = (note: string | null) => JSON.stringify({ schema: 1, slices: [{ id: 1, title: "Export", status: "red", commit: null, note }] });
const yes = (p = 0.95) => ({ value: true, p });
const no = (p = 0.05) => ({ value: false, p });
const waitFor = async (path: string) => {
  for (let i = 0; i < 100 && !existsSync(path); i++) await settle(10);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

function checks(out: string, decide: Decide | null, over: Partial<Parameters<typeof buildChecks>[0]> = {}) {
  return buildChecks({
    outDir: out,
    repoPath: "/repo",
    worktree: "/wt",
    inputCommit: "base",
    slices: [{ title: "Export", est_loc: 10, touchpoints: ["src/a.ts"], acceptance: ["returns csv"] }],
    planned: ["src/a.ts"],
    decide,
    overrides: {},
    git: { nameStatus: async () => "M\tsrc/a.ts\nA\tsrc/extra.ts", diff: async () => "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+// TODO later" },
    ...over,
  });
}

describe("the files the implementer declared to scope_check", () => {
  it("still count as declared when the final answer leaves them out: the machine took the declaration when it was made", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const c = checks(out, null, { planPresent: true });
    // The final answer declared nothing: src/extra.ts is outside the plan.
    expect((await c.finalFacts([])).undeclared).toEqual(["src/extra.ts"]);
    await c.onScopeRequest({ diffSummary: "x", outOfMap: [{ path: "src/extra.ts", reason: "its links broke with the move" }] });
    expect((await c.finalFacts([])).undeclared).toEqual([]);
  });
});

describe("a scenario's red check", () => {
  const scenarioCheck: CheckContext = { kind: "red", scenario: { id: "S1", title: "t" }, exists: true, output: "TypeError: x is not a function" };

  it("judges with the same questions as a slice's red: a confident no is a problem, whatever the verdict", async () => {
    const seen: unknown[] = [];
    const decide: Decide = async (pack, check, repo) => (seen.push([pack, check, repo]), { right_reason: no(), not_tautological: yes() });
    const answer = await judgeRedCheck(decide, scenarioCheck, "/repo", {});
    expect(seen).toEqual([["red_check", scenarioCheck, "/repo"]]);
    expect(answer.verdict).not.toBe("proceed");
    expect(answer.problems).toEqual([expect.stringContaining("reason other than the missing behaviour")]);
  });

  it("is skipped, with no problem, when no decision can run or it throws", async () => {
    expect(await judgeRedCheck(null, scenarioCheck, "/repo", {})).toEqual({ verdict: "skipped", problems: [] });
    expect(await judgeRedCheck((async () => { throw new Error("down"); }) as Decide, scenarioCheck, "/repo", {})).toEqual({ verdict: "skipped", problems: [] });
  });
});

describe("build checks", () => {
  it("answers a red slice in checks/red-<id>.json: the judged verdict, and a flag when an answer says no", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const asked: unknown[] = [];
    const decide: Decide = async (pack, check, repo) => {
      asked.push({ pack, check, repo });
      return { right_reason: no(), not_tautological: yes() };
    };
    const c = checks(out, decide);
    writeFileSync(join(out, "ledger.json"), redLedger("AssertionError: expected 404 to be 200"));
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onRed: c.onRed });
    const answer = await waitFor(join(out, "checks", "red-1.json"));
    await watch.stop();
    expect(asked).toEqual([{ pack: "red_check", repo: "/repo", check: { kind: "red", slice: { id: 1, title: "Export", acceptance: ["returns csv"] }, output: "AssertionError: expected 404 to be 200" } }]);
    expect(answer.verdict).not.toBe("proceed");
    expect(answer.problems).toEqual([expect.stringContaining("reason other than the missing behaviour")]);
  });

  it("asks once per red, and again when the slice leaves red and comes back", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const reds: number[] = [];
    writeFileSync(join(out, "ledger.json"), redLedger("AssertionError: first failure here"));
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onRed: async (s) => void reds.push(s.id) });
    await settle(40);
    expect(reds).toEqual([1]);
    writeFileSync(join(out, "ledger.json"), JSON.stringify({ schema: 1, slices: [{ id: 1, title: "Export", status: "green", commit: null }] }));
    await settle(30);
    writeFileSync(join(out, "ledger.json"), redLedger("AssertionError: first failure here"));
    await settle(40);
    await watch.stop();
    expect(reds).toEqual([1, 1]);
  });

  it("tells the truth of each judged red once the slice commits: a red the test was rewritten after was wrong, the last one was a true red", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const told: Learned[] = [];
    let n = 0;
    const decide: Decide = async () => tagged({ answer: { right_reason: yes(), not_tautological: yes() }, recordId: `red-${++n}` });
    const c = checks(out, decide, { truth: { learned: async (fact) => (told.push(fact), true) }, taskId: "task-4" });
    const slice = { id: 1, title: "Export", status: "red", commit: null, note: "AssertionError: first failure" } as never;
    await c.onRed(slice);
    await c.onRed({ ...(slice as object), note: "AssertionError: after the rewrite" } as never);
    await c.onGreen({ id: 1, title: "Export", status: "committed", commit: "abc" } as never);
    await c.onGreen({ id: 1, title: "Export", status: "committed", commit: "abc" } as never);
    expect(told).toEqual([
      { pack: "red_check", recordId: "red-1", label: { right_reason: { value: false } }, source: "slice_green", kind: "fact", taskId: "task-4" },
      { pack: "red_check", recordId: "red-2", label: { right_reason: { value: true } }, source: "slice_green", kind: "fact", taskId: "task-4" },
    ]);
  });

  it("answers a scope request with the facts and the judged verdict", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const seen: unknown[] = [];
    const decide: Decide = async (_pack, check) => {
      seen.push(check);
      return { planned_or_declared: no(), no_new_dependency: yes(), no_secret_or_pii: yes(), no_test_removed: yes(), no_todo: no(), unrelated_refactors: yes() };
    };
    const c = checks(out, decide);
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onScopeRequest: c.onScopeRequest });
    mkdirSync(join(out, "checks"), { recursive: true });
    writeFileSync(join(out, "checks", "scope-request.json"), JSON.stringify({ diffSummary: "adds export", outOfMap: [{ path: "src/util.ts", reason: "helper" }] }));
    const answer = await waitFor(join(out, "checks", "scope.json"));
    await watch.stop();
    expect(answer.facts).toMatchObject({ changed: ["src/a.ts", "src/extra.ts"], undeclared: ["src/extra.ts"], todos: ["src/a.ts: // TODO later"] });
    expect(answer.problems).toHaveLength(2);
    expect(answer.verdict).not.toBe("proceed");
    expect(seen).toEqual([expect.objectContaining({ kind: "scope", planned: ["src/a.ts"], declared: [{ path: "src/util.ts", reason: "helper" }], diffSummary: "adds export", undeclared: ["src/extra.ts"] })]);
  });

  it("says an unrelated refactor the check found, apart from the facts, and keeps what was judged for the final severity", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const decide: Decide = async () => ({ planned_or_declared: yes(), no_new_dependency: yes(), no_secret_or_pii: yes(), no_test_removed: yes(), no_todo: yes(), unrelated_refactors: no() });
    const c = checks(out, decide);
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onScopeRequest: c.onScopeRequest });
    mkdirSync(join(out, "checks"), { recursive: true });
    writeFileSync(join(out, "checks", "scope-request.json"), JSON.stringify({ diffSummary: "adds export and renames helpers", outOfMap: [] }));
    const answer = await waitFor(join(out, "checks", "scope.json"));
    await watch.stop();
    expect(answer.problems).toEqual([expect.stringContaining("unrelated refactor")]);
    expect(await c.lastJudged()).toEqual(["unrelated_refactor"]);
  });

  it("teaches scope_check from the diff by script: a TODO the diff added says no_todo was false, on the record the check left", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const learned: Learned[] = [];
    const decide: Decide = async () => tagged({ answer: { planned_or_declared: yes(), no_new_dependency: yes(), no_secret_or_pii: yes(), no_test_removed: yes(), no_todo: yes(), unrelated_refactors: yes() }, recordId: "rec-scope" });
    const c = checks(out, decide, { truth: { learned: async (fact) => (learned.push(fact), true) }, taskId: "task-1" });
    await c.onScopeRequest({ diffSummary: "x", outOfMap: [] });
    expect(learned).toEqual([{ pack: "scope_check", recordId: "rec-scope", label: { no_todo: { value: false } }, kind: "fact", source: "scope_facts", taskId: "task-1" }]);
  });

  it("teaches nothing when the diff holds no finding, when the check left no record, or when the diff cannot be read", async () => {
    const clean = { nameStatus: async () => "M\tsrc/a.ts", diff: async () => "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+const a = 1;" };
    for (const [over, decide] of [
      [{ git: clean }, async () => tagged({ answer: {}, recordId: "r" })],
      [{}, async () => ({ planned_or_declared: yes() })],
      [{ git: { nameStatus: async () => "", diff: async () => { throw new Error("no git"); } } }, async () => tagged({ answer: {}, recordId: "r" })],
    ] as const) {
      const learned: Learned[] = [];
      const c = checks(mkdtempSync(join(tmpdir(), "build-checks-")), decide as Decide, { ...over, truth: { learned: async (fact) => (learned.push(fact), true) }, taskId: "t" });
      await c.onScopeRequest({ diffSummary: "x", outOfMap: [] });
      expect(learned).toEqual([]);
    }
  });

  it("answers skipped when no decision can run, or the decision throws", async () => {
    for (const decide of [null, (async () => { throw new Error("no jev"); }) as Decide]) {
      const out = mkdtempSync(join(tmpdir(), "build-checks-"));
      const logged: string[] = [];
      const c = checks(out, decide, { log: (l) => void logged.push(l) });
      await c.onRed({ id: 1, title: "Export", status: "red", commit: null, note: "AssertionError: expected 404" });
      expect(JSON.parse(readFileSync(join(out, "checks", "red-1.json"), "utf8"))).toEqual({ verdict: "skipped", problems: [] });
      await c.onScopeRequest({ diffSummary: "x", outOfMap: [] });
      expect(JSON.parse(readFileSync(join(out, "checks", "scope.json"), "utf8"))).toMatchObject({ verdict: "skipped", problems: [], facts: { undeclared: ["src/extra.ts"] } });
      expect(logged.length).toBe(decide ? 2 : 0);
    }
  });

  it("proceeds when every answer is a confident yes, and computes the final facts with the declared files", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const decide: Decide = async () => ({ right_reason: yes(), not_tautological: yes() });
    const c = checks(out, decide);
    await c.onRed({ id: 1, title: "Export", status: "red", commit: null, note: "AssertionError: expected 404" });
    expect(JSON.parse(readFileSync(join(out, "checks", "red-1.json"), "utf8"))).toEqual({ verdict: "proceed", problems: [] });
    expect((await c.finalFacts([{ path: "src/extra.ts" }])).undeclared).toEqual([]);
    expect(await c.lastVerdict()).toBe("skipped");
  });
});

describe("bounds a run's checks", () => {
  const ledgerOf = (slices: Array<{ id: number; status: string; note?: string; commit?: string | null }>) =>
    JSON.stringify({ schema: 1, slices: slices.map((s) => ({ id: s.id, title: `slice ${s.id}`, status: s.status, commit: s.commit ?? null, note: s.note ?? null })) });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("judges at most MAX_REDS_PER_SLICE reds of one slice and MAX_SCOPE_REQUESTS scope requests", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-watch-caps-"));
    mkdirSync(join(out, "checks"), { recursive: true });
    const reds: string[] = [];
    const requests: string[] = [];
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onRed: async (s) => void reds.push(s.note ?? ""), onScopeRequest: async (r) => void requests.push(r.diffSummary) });
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(join(out, "ledger.json"), ledgerOf([{ id: 1, status: "red", note: `attempt ${n} failed with a long enough note` }]));
      writeFileSync(join(out, "checks", "scope-request.json"), JSON.stringify({ diffSummary: `request ${n}`, outOfMap: [] }));
      await wait(40);
    }
    await watch.stop();
    expect(reds).toHaveLength(MAX_REDS_PER_SLICE);
    expect(requests).toHaveLength(MAX_SCOPE_REQUESTS);
  });

  it("hands the decision only the tail of a long red note, and keeps the verdict it gave in memory", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-watch-mem-"));
    const seen: CheckContext[] = [];
    const checks = buildChecks({
      outDir: out, repoPath: "/r", worktree: "/wt", inputCommit: "base", slices: [{ title: "s1", est_loc: 1, touchpoints: ["a.ts"], acceptance: ["ok"] }], planned: ["a.ts"],
      decide: async (pack, check) => {
        seen.push(check);
        return pack === "red_check"
          ? { right_reason: { value: true, p: 0.9 }, not_tautological: { value: true, p: 0.9 } }
          : { planned_or_declared: { value: true, p: 0.9 }, no_new_dependency: { value: true, p: 0.9 }, no_secret_or_pii: { value: true, p: 0.9 }, no_test_removed: { value: true, p: 0.9 }, no_todo: { value: false, p: 0.1 }, unrelated_refactors: { value: true, p: 0.9 } };
      },
      overrides: {},
      git: { nameStatus: async () => "M\ta.ts", diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+// TODO later\n" },
    });
    await checks.onRed({ id: 1, title: "s1", status: "red", commit: null, note: "x".repeat(10_000) });
    expect(seen[0]!.output!.length).toBeLessThanOrEqual(NOTE_TAIL);
    await checks.onScopeRequest({ diffSummary: "d", outOfMap: [] });
    expect(await checks.lastVerdict()).toBe("flag");
    writeFileSync(join(out, "checks", "scope.json"), JSON.stringify({ verdict: "proceed", problems: [] }));
    expect(await checks.lastVerdict()).toBe("flag");
  });
});

describe("the board search mailbox", () => {
  it("answers each query the triage agent writes with the cards of the task's own repository, as ids and titles only", async () => {
    const out = mkdtempSync(join(tmpdir(), "card-search-"));
    const asked: string[] = [];
    const answers = cardSearchAnswers({ outDir: out, search: async (query) => (asked.push(query), [{ id: "c1", title: "Export CSV", state: "triage" }]) });
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onCardSearch: answers.onCardSearch });
    mkdirSync(join(out, "checks"), { recursive: true });
    writeFileSync(join(out, "checks", "card-search-request.json"), JSON.stringify({ query: "csv export", repoPath: "/some/other/repo" }));
    const answer = await waitFor(join(out, "checks", "card-search.json"));
    await watch.stop();
    expect(asked).toEqual(["csv export"]);
    expect(answer).toEqual({ verdict: "ok", problems: [], cards: [{ id: "c1", title: "Export CSV", state: "triage" }] });
  });

  it("answers at most MAX_CARD_SEARCHES queries per run and ignores a request with no text query", async () => {
    const out = mkdtempSync(join(tmpdir(), "card-search-caps-"));
    mkdirSync(join(out, "checks"), { recursive: true });
    const queries: string[] = [];
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async () => {}, onCardSearch: async (q) => void queries.push(q) });
    writeFileSync(join(out, "checks", "card-search-request.json"), JSON.stringify({ query: 5 }));
    await settle(30);
    for (let n = 1; n <= MAX_CARD_SEARCHES + 2; n++) {
      writeFileSync(join(out, "checks", "card-search-request.json"), JSON.stringify({ query: `q${n}` }));
      await settle(30);
    }
    await watch.stop();
    expect(queries).toHaveLength(MAX_CARD_SEARCHES);
    expect(queries[0]).toBe("q1");
  });
});

describe("the mailbox is read and written as the container's, not the machine's", () => {
  const out = () => {
    const dir = mkdtempSync(join(tmpdir(), "mailbox-"));
    mkdirSync(join(dir, "checks"));
    return dir;
  };

  it("reads a regular file of a request, and nothing for a file that is not there", async () => {
    const dir = out();
    writeFileSync(join(dir, "checks", "scope-request.json"), '{"diffSummary":"x"}');
    expect(await readMailbox(dir, "scope-request.json")).toBe('{"diffSummary":"x"}');
    expect(await readMailbox(dir, "card-search-request.json")).toBeNull();
  });

  it("refuses a request that is a symlink, even to a file with real content", async () => {
    const dir = out();
    const secret = join(dir, "secret.json");
    writeFileSync(secret, '{"query":"credential"}');
    symlinkSync(secret, join(dir, "checks", "card-search-request.json"));
    expect(await readMailbox(dir, "card-search-request.json")).toBeNull();
    // and the watch never hands it to a handler
    const asked: string[] = [];
    const watch = buildWatch({ outDir: dir, every: 5, onCommitted: async () => {}, onCardSearch: async (q) => void asked.push(q) });
    await settle(40);
    await watch.stop();
    expect(asked).toEqual([]);
  });

  it("refuses a request over 64 KiB, and takes one right at the limit", async () => {
    const dir = out();
    writeFileSync(join(dir, "checks", "scope-request.json"), "x".repeat(MAX_MAILBOX_BYTES + 1));
    expect(await readMailbox(dir, "scope-request.json")).toBeNull();
    writeFileSync(join(dir, "checks", "scope-request.json"), "x".repeat(MAX_MAILBOX_BYTES));
    expect((await readMailbox(dir, "scope-request.json"))?.length).toBe(MAX_MAILBOX_BYTES);
  });

  it("reads nothing when checks/ is itself a link out of the run folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailbox-link-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "mailbox-elsewhere-"));
    writeFileSync(join(elsewhere, "scope-request.json"), "{}");
    symlinkSync(elsewhere, join(dir, "checks"));
    expect(await readMailbox(dir, "scope-request.json")).toBeNull();
    await expect(writeMailbox(dir, "scope.json", "{}")).rejects.toThrow(/not a directory/);
    expect(existsSync(join(elsewhere, "scope.json"))).toBe(false);
  });

  it("writes an answer over a leftover temp file, and never through a link the container left in its place", async () => {
    const dir = out();
    const target = join(dir, "victim.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "checks", ".scope.json.tmp"));
    await writeMailbox(dir, "scope.json", '{"verdict":"proceed"}');
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(readFileSync(join(dir, "checks", "scope.json"), "utf8")).toBe('{"verdict":"proceed"}');
    expect(lstatSync(join(dir, "checks", "scope.json")).isFile()).toBe(true);
    writeFileSync(join(dir, "checks", ".scope.json.tmp"), "leftover");
    await writeMailbox(dir, "scope.json", '{"verdict":"flag"}');
    expect(readFileSync(join(dir, "checks", "scope.json"), "utf8")).toBe('{"verdict":"flag"}');
  });
});

describe("a deleted test the card's own branch wrote", () => {
  const nameStatus = "M\tdocs/README.md\nD\tcontracts/src/readme-ste.test.ts\nD\tcontracts/src/readme.test.ts";
  // The prose test carried scenario tags: its deletion removes them.
  const diff = ["diff --git a/contracts/src/readme-ste.test.ts b/contracts/src/readme-ste.test.ts", "deleted file mode 100644", "--- a/contracts/src/readme-ste.test.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-// @scenario:S1", "-it('x', () => {})"].join("\n");
  const repoFiles = async () => new Set(["contracts/src/readme.test.ts"]);

  it("on a docs-only run is neither a removed test, a lost scenario tag nor an undeclared change; a deleted test of the repo's stays all of those", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const c = checks(out, null, { planPresent: true, planned: ["docs/README.md"], git: { nameStatus: async () => nameStatus, diff: async () => diff }, repoFiles });
    const facts = await c.finalFacts([]);
    expect(facts.removedTests).toEqual(["contracts/src/readme.test.ts"]);
    expect(facts.undeclared).toEqual(["contracts/src/readme.test.ts"]);
    expect(facts.weakened).toEqual([]);
  });
  it("on a run that protects scenario tests keeps every check: a feature card's scenario test may not be deleted", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const c = checks(out, null, { planPresent: true, planned: ["docs/README.md"], scenarioTests: [{ scenario: "S1", file: "contracts/src/readme-ste.test.ts" }], git: { nameStatus: async () => nameStatus, diff: async () => diff }, repoFiles });
    const facts = await c.finalFacts([]);
    expect(facts.removedTests).toContain("contracts/src/readme-ste.test.ts");
    expect(facts.weakened).toContain("S1");
  });
  it("counts every deleted test when the machine cannot tell whose it is", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const c = checks(out, null, { planPresent: true, planned: ["docs/README.md"], git: { nameStatus: async () => nameStatus, diff: async () => diff } });
    expect((await c.finalFacts([])).removedTests).toEqual(["contracts/src/readme-ste.test.ts", "contracts/src/readme.test.ts"]);
  });
});
