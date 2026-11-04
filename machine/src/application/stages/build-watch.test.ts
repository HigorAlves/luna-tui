// The build watch follows an implementing run's /out while the container runs: a slice turned
// committed is pushed as it lands, so a killed container never loses a green slice.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type Decide, buildChecks, buildWatch } from "./build-watch.ts";

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
    git: { nameStatus: async () => "M\tsrc/a.ts\nA\tsrc/extra.ts", diff: async () => "+++ b/src/a.ts\n@@ -1 +1 @@\n+// TODO later" },
    ...over,
  });
}

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

  it("answers a scope request with the facts and the judged verdict", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-checks-"));
    const seen: unknown[] = [];
    const decide: Decide = async (_pack, check) => {
      seen.push(check);
      return { planned_or_declared: no(), no_new_dependency: yes(), no_secret_or_pii: yes(), no_test_removed: yes(), no_todo: no() };
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
