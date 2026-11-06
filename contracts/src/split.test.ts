import { describe, expect, it } from "vitest";

import { PACKS, SizeContext, SplitChild, SplitContext, StageInput } from "./index.ts";

const child = { title: "Export button", goal: "Add the export button", acceptance_criteria: ["It downloads a file"], covers: ["C1"], files_hint: ["src/export.ts"], est_loc: 300, depends_on: [], order: 1 };

describe("SplitChild", () => {
  it("parses a child with the keys the plan lists", () => {
    expect(SplitChild.safeParse(child).success).toBe(true);
  });

  it("has no key for a repository, a branch, a base, an engine or an owner", () => {
    for (const key of ["repo", "repoPath", "branch", "base", "engine", "owner"]) {
      expect(SplitChild.safeParse({ ...child, [key]: "x" }).success, key).toBe(false);
    }
  });

  it("bounds each field: criteria 1 to 10, covers ids C1..C999, estimate 1 to 100000, depends_on 19 integers", () => {
    expect(SplitChild.safeParse({ ...child, acceptance_criteria: [] }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, acceptance_criteria: Array(11).fill("x") }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, covers: ["criterion one"] }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, est_loc: 0 }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, est_loc: 100_001 }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, depends_on: Array(20).fill(1) }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, title: "x".repeat(201) }).success).toBe(false);
    expect(SplitChild.safeParse({ ...child, order: 21 }).success).toBe(false);
  });
});

describe("SizeContext and SplitContext", () => {
  const size = { title: "t", text: "x", criteria: ["a"], files: [{ path: "src/a.ts" }, { path: "src/b.ts", role: "route" }], symbols: ["f"], similar: [{ title: "s", added: 10, removed: 2 }], limit: { target: [1000, 2000], hard: 2500 } };
  const split = { origin: { title: "t", text: "x", criteria: [{ id: "C1", text: "a" }] }, files: [{ path: "src/a.ts" }], limit: { target: [1000, 2000], hard: 2500, maxChildren: 8 }, children: [child], round: 1 };

  it("parse their documented shape, and cap the lists", () => {
    expect(SizeContext.safeParse(size).success).toBe(true);
    expect(SizeContext.safeParse({ ...size, similar: Array(6).fill(size.similar[0]) }).success).toBe(false);
    expect(SplitContext.safeParse(split).success).toBe(true);
    expect(SplitContext.safeParse({ ...split, issues: ["a"], note: "n" }).success).toBe(true);
    expect(SplitContext.safeParse({ ...split, children: Array(21).fill(child) }).success).toBe(false);
  });

  it("ride on the stage input's context as size and split", () => {
    const base = { schema: 3, stage: "size_estimate", pack: "size_estimate", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1000 }, env: {} };
    expect(StageInput.safeParse({ ...base, context: { projectContext: null, size } }).success).toBe(true);
    expect(StageInput.safeParse({ ...base, stage: "split_check", pack: "split_check", context: { projectContext: null, split } }).success).toBe(true);
  });
});

describe("the size_estimate and split_check decision packs", () => {
  it("size_estimate asks a seven-level est_loc score, a five-level est_files score and a reviewable yes or no", () => {
    const pack = PACKS.size_estimate;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["est_loc", "est_files", "reviewable"]);
    const q = pack.questions as Record<string, { type: string; rubric?: Record<string, string> }>;
    expect(q.est_loc!.type).toBe("score");
    expect(Object.keys(q.est_loc!.rubric!)).toHaveLength(7);
    expect(Object.keys(q.est_files!.rubric!)).toHaveLength(5);
    expect(q.reviewable!.type).toBe("yesno");
    expect(pack.answer.safeParse({ est_loc: { score: 6, confidence: 0.9 }, est_files: { score: 4, confidence: 0.9 }, reviewable: { value: false, p: 0.1 } }).success).toBe(true);
    expect(pack.answer.safeParse({ est_loc: { score: 7, confidence: 0.9 }, est_files: { score: 4, confidence: 0.9 }, reviewable: { value: false, p: 0.1 } }).success).toBe(false);
  });

  it("split_check asks covers, no_overlap and stand_alone as yes or no", () => {
    const pack = PACKS.split_check;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["covers", "no_overlap", "stand_alone"]);
    for (const q of Object.values(pack.questions)) expect(q.type).toBe("yesno");
  });
});
