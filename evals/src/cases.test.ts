import { PACKS, PACK_LIMITS, StageInput } from "@hardness/contracts";
import { contextSchema } from "@hardness/machine/decisions";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readingProblems } from "./preflight.ts";
import { TOKEN_SHAPE } from "./scrub.ts";
import { baselinePath, caseInput, datasetCases, engineSlug, judgeInput, loadCases, mcpServersOf, parseEffort, parseTrials, prepareWorktree, verdictOf } from "./cases.ts";

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

  it("adds an effort to the run only when one is given", () => {
    expect(caseInput(input(), "codex:sol")).not.toHaveProperty("effort");
    expect(caseInput(input(), "codex:sol", "high")).toMatchObject({ effort: "high" });
  });

  it("reads --effort: low, medium or high, else a refusal", () => {
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort("medium")).toBe("medium");
    expect(() => parseEffort("max")).toThrow("--effort must be low, medium or high");
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

  it("keeps a baseline per effort in its own folder, and the old paths as they were", () => {
    expect(baselinePath("/e", "claude:opus", "plan", "high")).toBe("/e/baselines/claude-opus@high/plan.json");
    expect(engineSlug("codex:sol")).toBe("codex-sol");
    expect(engineSlug("codex:sol", "low")).toBe("codex-sol@low");
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

  it("has a case for each of the thirty-one decision packs' four kinds: two clear, one borderline checked on confidence, one adversarial", () => {
    expect(decisions).toHaveLength(31);
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

describe("a case's replayed design servers", () => {
  const stageOf = (pack: string) => ({ ...input({ repoPath: "" }), stage: pack, pack });
  const expectJson = { schema: 1, outcome: "pass", checks: [], rubric: "r".repeat(100) };
  const write = (dir: string, stage: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stage.json"), JSON.stringify(stage));
    writeFileSync(join(dir, "expect.json"), JSON.stringify(expectJson));
  };

  it("reads a case's mcp folder as the replayed design servers, and refuses one for a pack with no design tools", () => {
    const root = mkdtempSync(join(tmpdir(), "evals-"));
    const caseDir = join(root, "design_spec", "cases", "checkout");
    write(caseDir, stageOf("design_spec"));
    mkdirSync(join(caseDir, "mcp", "figma", "get_design_context"), { recursive: true });
    writeFileSync(join(caseDir, "mcp", "figma", "tools.json"), JSON.stringify([{ server: "figma", tool: "get_design_context", description: "d", inputSchema: {} }]));
    const [c] = loadCases(root, "design_spec");
    expect(c!.id).toBe("checkout");
    expect(c!.mcpDir).toBe(join(caseDir, "mcp"));
    expect(mcpServersOf(c!.mcpDir!)).toEqual([expect.objectContaining({ name: "figma", transport: "http", credential: { kind: "none" }, tools: ["get_design_context"] })]);
    write(join(root, "plan", "cases", "x"), stageOf("plan"));
    mkdirSync(join(root, "plan", "cases", "x", "mcp"), { recursive: true });
    expect(() => loadCases(root, "plan")).toThrow(/plan has no design tools: the mcp folder of case x cannot be replayed/);
  });

  it("leaves mcpDir unset for a case with no mcp folder", () => {
    const root = mkdtempSync(join(tmpdir(), "evals-"));
    write(join(root, "design_spec", "cases", "bare"), stageOf("design_spec"));
    expect(loadCases(root, "design_spec")[0]!.mcpDir).toBeUndefined();
  });
});
