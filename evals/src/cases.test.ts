import { PACK_LIMITS, StageInput } from "@hardness/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { baselinePath, caseInput, judgeInput, loadCases, prepareWorktree, verdictOf } from "./cases.ts";

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

describe("the seed cases", () => {
  const EVALS = resolve(import.meta.dirname, "..");
  const packs = readdirSync(EVALS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(EVALS, d.name, "cases"))).map((d) => d.name);

  it("cover triage, slack_triage and issue_classify, three cases each at least", () => {
    expect(packs.sort()).toEqual(expect.arrayContaining(["issue_classify", "slack_triage", "triage"]));
    for (const pack of packs) expect(loadCases(EVALS, pack as "triage").length).toBeGreaterThanOrEqual(3);
  });

  it.each(packs)("%s: every case loads, names a fixture that exists, and carries no token or real address", (pack) => {
    for (const evalCase of loadCases(EVALS, pack as "triage")) {
      const repo = evalCase.input.task.repoPath;
      if (repo !== "") expect(existsSync(join(ROOT, repo)), `${evalCase.id}: ${repo}`).toBe(true);
      const text = JSON.stringify(evalCase);
      expect(text, evalCase.id).not.toMatch(/xox[abposr]-|ghp_|github_pat_|\bsk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12}|eyJ[A-Za-z0-9_-]{20,}/);
      expect(text, evalCase.id).not.toMatch(/@(?!example)[a-z0-9-]+\.(com|io|dev|net|org)\b/i);
    }
  });
});
