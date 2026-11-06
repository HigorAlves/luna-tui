import { PACKS, PACK_LIMITS, StageInput } from "@hardness/contracts";
import { contextSchema } from "@hardness/machine/decisions";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readingProblems } from "./preflight.ts";
import { TOKEN_SHAPE } from "./scrub.ts";
import { baselinePath, caseInput, datasetCases, judgeInput, loadCases, parseTrials, prepareWorktree, verdictOf } from "./cases.ts";

/** Every `@host` whose host is not a reserved one: `.example`, `example.com|org|net` or `.invalid`. */
const unsafeAddresses = (text: string): string[] => [...text.matchAll(/@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1]!).filter((host) => !/(?:^|\.)example(?:\.(?:com|org|net))?$|\.invalid$|^example$/i.test(host));

const ROOT = resolve(import.meta.dirname, "..", "..");

const input = (over: Partial<StageInput["task"]> = {}): StageInput =>
  StageInput.parse({
    schema: 3,
    stage: "triage",
    pack: "triage",
    attempt: 1,
    task: { id: "eval-1", title: "Cart totals", description: "d", criteria: ["c"], repoPath: "fixtures/golden-task", branch: "task/eval-1", source: null, ...over },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null },
    limits: { maxTurns: 1, timeoutMs: 1 },
    env: { LUNA_FACTORY: "1" },
  });

function caseDir(files: Record<string, unknown>): string {
  const evals = mkdtempSync(join(tmpdir(), "evals-cases-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(evals, rel, ".."), { recursive: true });
    writeFileSync(join(evals, rel), JSON.stringify(body));
  }
  return evals;
}

describe("loadCases", () => {
  it("reads every case of a pack in order, or the ones named, and refuses an unknown name", () => {
    const evals = caseDir({
      "triage/cases/b/stage.json": input(),
      "triage/cases/b/expect.json": { schema: 1, rubric: "r" },
      "triage/cases/a/stage.json": input(),
      "triage/cases/a/expect.json": { schema: 1, rubric: "r", checks: [{ kind: "equals", path: "kind", value: "brief" }] },
    });
    expect(loadCases(evals, "triage").map((c) => c.id)).toEqual(["a", "b"]);
    expect(loadCases(evals, "triage", ["b"]).map((c) => c.id)).toEqual(["b"]);
    expect(() => loadCases(evals, "triage", ["zz"])).toThrow("no triage case named zz (have: a, b)");
    expect(loadCases(evals, "slack_triage")).toEqual([]);
  });

  it("names the file and the problem when a case is off its schema or under the wrong pack", () => {
    expect(() => loadCases(caseDir({ "triage/cases/a/stage.json": { schema: 3 }, "triage/cases/a/expect.json": { schema: 1, rubric: "r" } }), "triage")).toThrow(/a\/stage\.json: /);
    expect(() => loadCases(caseDir({ "triage/cases/a/stage.json": input(), "triage/cases/a/expect.json": { schema: 1 } }), "triage")).toThrow(/a\/expect\.json: rubric/);
    const wrong = { ...input(), pack: "setup" };
    expect(() => loadCases(caseDir({ "triage/cases/a/stage.json": wrong, "triage/cases/a/expect.json": { schema: 1, rubric: "r" } }), "triage")).toThrow("pack setup, but the case is under triage");
  });
});

describe("prepareWorktree", () => {
  it("copies the fixture into a fresh git repo on the task's branch, without .golden", () => {
    const runDir = mkdtempSync(join(tmpdir(), "evals-work-"));
    const work = prepareWorktree(input(), ROOT, runDir);
    expect(work).toBe(join(runDir, "work"));
    expect(existsSync(join(ROOT, "fixtures/golden-task/.golden"))).toBe(true);
    expect(readdirSync(work).sort()).toEqual([".git", "README.md", "package.json", "src", "test"]);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: work, encoding: "utf8" }).trim()).toBe("task/eval-1");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: work, encoding: "utf8" })).toBe("");
  });

  it("leaves /work empty for a case with no fixture, and refuses a fixture that is not there", () => {
    const runDir = mkdtempSync(join(tmpdir(), "evals-work-"));
    expect(readdirSync(prepareWorktree(input({ repoPath: "" }), ROOT, runDir))).toEqual([]);
    expect(() => prepareWorktree(input({ repoPath: "fixtures/nope" }), ROOT, mkdtempSync(join(tmpdir(), "evals-work-")))).toThrow("fixture fixtures/nope not found");
  });
});

describe("the runs' inputs", () => {
  it("runs a case on the engine asked for, with the pack's limits today", () => {
    const run = caseInput(input(), "codex:sol");
    expect(run).toMatchObject({ engine: "codex:sol", limits: { maxTurns: PACK_LIMITS.triage.maxTurns, timeoutMs: PACK_LIMITS.triage.timeoutMs }, task: { repoPath: "fixtures/golden-task" } });
  });

  it("gives the judge the case, its rubric and checks, and the answer, on its own engine and limits", () => {
    const evalCase = { id: "bug", pack: "triage" as const, input: input(), expect: { schema: 1 as const, rubric: "names formatPrice", checks: [{ kind: "equals" as const, path: "kind", value: "brief" }] } };
    const judged = judgeInput(evalCase, { kind: "brief" }, "claude:opus");
    expect(StageInput.safeParse(judged).success).toBe(true);
    expect(judged).toMatchObject({ pack: "eval_judge", engine: "claude:opus", limits: { maxTurns: PACK_LIMITS.eval_judge.maxTurns }, task: { repoPath: "" } });
    expect(judged.context.eval).toMatchObject({ pack: "triage", caseId: "bug", rubric: "names formatPrice", answer: '{\n  "kind": "brief"\n}' });
    expect(JSON.parse(judged.context.eval!.input)).toMatchObject({ task: { title: "Cart totals" }, plan: null });
    expect(JSON.parse(judged.context.eval!.checks)).toEqual([{ kind: "equals", path: "kind", value: "brief" }]);
  });

  it("reads the judge's verdict, or why it is unusable", () => {
    expect(verdictOf({ score: 0.9, pass: true, reasons: ["ok"] }, 0.1)).toEqual({ score: 0.9, pass: true, reasons: ["ok"], costUsd: 0.1 });
    expect(verdictOf({ score: 2, pass: true, reasons: [] }, null)).toMatchObject({ error: expect.stringContaining("score") });
  });

  it("keeps a baseline per engine and pack, with no colon in the path", () => {
    expect(baselinePath("/e", "claude:opus", "triage")).toBe("/e/baselines/claude-opus/triage.json");
  });
});

describe("cases from a dataset", () => {
  const retro = { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMs: 1, durationMin: 310 }, runs: 14 } };

  it("makes an EvalCase of each labelled datapoint, the taskId as its id, and skips a bad one", () => {
    const { cases, skipped } = datasetCases("worth_learning", [
      { taskId: "reviewed/1", data: { ship: retro }, target: { worth: { value: true } } },
      { taskId: "broken", data: { ship: { kind: "nope" } }, target: { worth: { value: true } } },
    ]);
    expect(cases.map((c) => [c.id, c.pack, c.input.pack])).toEqual([["reviewed-1", "worth_learning", "worth_learning"]]);
    expect(cases[0]!.expect.checks).toEqual([{ kind: "equals", path: "worth.value", value: true }]);
    expect(skipped.map((s) => s.taskId)).toEqual(["broken"]);
  });

  it("reads --trials as 1 to 20", () => {
    expect([parseTrials(undefined), parseTrials("3")]).toEqual([1, 3]);
    for (const bad of ["0", "21", "x", "1.5"]) expect(() => parseTrials(bad)).toThrow(/--trials/);
  });
});

describe("the case gate", () => {
  it("refuses a host that is not reserved, and accepts the reserved ones", () => {
    expect(unsafeAddresses("a@acme.dev b@corp.internal c@mail.example d@example.org e@x.invalid")).toEqual(["acme.dev", "corp.internal"]);
  });
});

describe("the seed cases", () => {
  const EVALS = resolve(import.meta.dirname, "..");
  const packs = readdirSync(EVALS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(EVALS, d.name, "cases"))).map((d) => d.name);

  it("cover triage, slack_triage and triage_signals, three cases each at least", () => {
    expect(packs.sort()).toEqual(expect.arrayContaining(["triage_signals", "slack_triage", "triage"]));
    for (const pack of packs) expect(loadCases(EVALS, pack as "triage").length).toBeGreaterThanOrEqual(3);
  });

  it.each(packs)("%s: every case loads, names a fixture that exists, and carries no token or real address", (pack) => {
    for (const evalCase of loadCases(EVALS, pack as "triage")) {
      const repo = evalCase.input.task.repoPath;
      if (repo !== "") expect(existsSync(join(ROOT, repo)), `${evalCase.id}: ${repo}`).toBe(true);
      const text = JSON.stringify(evalCase);
      expect(text, evalCase.id).not.toMatch(TOKEN_SHAPE);
      expect(unsafeAddresses(text), evalCase.id).toEqual([]);
    }
  });

  const decisions = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);

  it("has a case for each of the twenty-five decision packs' four kinds: two clear, one borderline checked on confidence, one adversarial", () => {
    expect(decisions).toHaveLength(25);
    for (const pack of decisions) {
      const cases = loadCases(EVALS, pack as "triage");
      expect(cases.length, pack).toBeGreaterThanOrEqual(4);
      const labelled = cases.filter((c) => c.expect.label);
      const borderline = cases.filter((c) => !c.expect.label && c.expect.checks.some((k) => k.kind === "between" && /\.(p|confidence)$/.test(k.path)));
      expect(labelled.length, `${pack}: labelled`).toBeGreaterThanOrEqual(pack === "triage_signals" ? 1 : 3);
      expect(borderline.length, `${pack}: borderline`).toBeGreaterThanOrEqual(1);
      // A label that names an answer's key must name one of the pack's questions, and a case is never left for review once committed.
      for (const c of cases) {
        for (const question of Object.keys(c.expect.label ?? {})) expect(Object.keys(PACKS[pack as "worth_learning"].questions), `${pack}/${c.id}`).toContain(question);
        expect(c.expect.review, `${pack}/${c.id}`).toBeUndefined();
      }
    }
  });

  it.each(decisions)("%s: every context parses with the pack's context schema, and a clear or adversarial case has checks", (pack) => {
    for (const c of loadCases(EVALS, pack as "triage")) {
      const context = Object.fromEntries(Object.entries(c.input.context).filter(([key, value]) => key !== "projectContext" && value !== undefined));
      expect(contextSchema(pack as "worth_learning").safeParse(context).success, `${pack}/${c.id}`).toBe(true);
      expect(c.expect.checks.length, `${pack}/${c.id}`).toBeGreaterThan(0);
    }
  });
});

/** Every decision pack: a pack added later is checked from its first case. */
const READ: string[] = Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);

describe("the readings of the hand-written cases", () => {
  const EVALS = resolve(import.meta.dirname, "..");
  it("hold for every pack in READ: the label is tied to the pack's own criterion text, the twin differs, a borderline case has two readings", () => {
    const problems = READ.flatMap((pack) => readingProblems(EVALS, pack as "worth_learning"));
    expect(problems).toEqual([]);
  });
});
