// The build watch follows an implementing run's /out while the container runs: a slice turned
// committed is pushed as it lands, so a killed container never loses a green slice.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CheckContext } from "@hardness/contracts";

import { type Learned, tagged } from "../decision-truth.ts";
import { type Decide, MAX_REDS_PER_SLICE, MAX_SCOPE_REQUESTS, NOTE_TAIL, buildChecks, buildWatch } from "./build-watch.ts";

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
      { pack: "red_check", recordId: "red-1", label: { right_reason: { value: false } }, source: "slice_green", taskId: "task-4" },
      { pack: "red_check", recordId: "red-2", label: { right_reason: { value: true } }, source: "slice_green", taskId: "task-4" },
    ]);
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
          : { planned_or_declared: { value: true, p: 0.9 }, no_new_dependency: { value: true, p: 0.9 }, no_secret_or_pii: { value: true, p: 0.9 }, no_test_removed: { value: true, p: 0.9 }, no_todo: { value: false, p: 0.1 } };
      },
      overrides: {},
      git: { nameStatus: async () => "M\ta.ts", diff: async () => "+++ b/a.ts\n+// TODO later\n" },
    });
    await checks.onRed({ id: 1, title: "s1", status: "red", commit: null, note: "x".repeat(10_000) });
    expect(seen[0]!.output!.length).toBeLessThanOrEqual(NOTE_TAIL);
    await checks.onScopeRequest({ diffSummary: "d", outOfMap: [] });
    expect(await checks.lastVerdict()).toBe("flag");
    writeFileSync(join(out, "checks", "scope.json"), JSON.stringify({ verdict: "proceed", problems: [] }));
    expect(await checks.lastVerdict()).toBe("flag");
  });
});
