import { EvidencePack, type Finding, type VerifyReport } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { assembleEvidencePack, packComplete } from "./evidence-pack.ts";

const now = new Date("2026-11-04T10:00:00.000Z");
const record = { source: "github", kind: "feature", goal: "Show the cart total in the header", size: "small", urgency: "normal", risk: "low" as const, signals: {}, qa: [], decision: "plan" as const, reason: "r", at: "2026-11-03T00:00:00.000Z", model: "m" };
const finding = (over: Partial<Finding> = {}): Finding => ({ path: "web/cart.tsx", line: 42, severity: "should_fix", title: "total is not memoised", body: "b", confidence: 0.7, ...over });

const full = {
  task: { title: "Cart total", description: "Show the total" },
  record,
  plan: { rollback: "Revert the merge commit.", risk: "medium" as const },
  scenarios: [
    { text: "Total shows after adding an item", criterion: "total visible", result: "pass" as const, test: "e2e/cart.spec.ts" },
    { text: "Total updates on removal", criterion: null, result: "partial" as const, test: null },
    { text: "Empty cart shows zero", criterion: "zero", result: "fail" as const, test: null },
  ],
  findings: [finding(), finding({ severity: "bug", title: "NaN on empty", path: "web/total.ts", line: 7 })],
  outOfMap: [{ path: "web/format.ts", reason: "shared currency helper" }],
  media: [
    { kind: "video" as const, label: "walkthrough", url: "/state/evidence/t/abc/walk.mp4" },
    { kind: "screenshot" as const, label: "cart.png", url: "/state/evidence/t/abc/cart.png" },
    { kind: "report" as const, label: "qa-manifest.json", url: "/state/evidence/t/abc/qa-manifest.json" },
  ],
  commitSha: "abc1234def5678",
  format: "captures" as const,
  howToVerify: "open https://stg.example.com/cart",
  now,
};

const verifyReport: VerifyReport = {
  prNumber: 7,
  headSha: "abc1234def5678",
  findings: [{ ...finding(), id: "F1", resolution: { status: "fixed", by: "implementer", commit: "c0ffee" } }, { ...finding({ title: "naming" }), id: "F2" }],
  tests: { passed: 9, total: 10 },
  coverageDelta: { files: [], total: { added: 20, covered: 18 }, report: "lcov.info" },
  e2e: { verdict: "pass", scenarios: [{ text: "a", result: "pass" }, { text: "b", result: "fail" }, { text: "c", result: "pass" }], artifacts: [] },
  envReproduction: null,
  overrides: [],
  version: 2,
};

describe("assembleEvidencePack with a Verify Report", () => {
  it("fills results, findingsDetail, the local path of kept media and the version", () => {
    const pack = assembleEvidencePack({ ...full, verifyReport, media: [...full.media, { kind: "video", label: "remote", url: "https://x.example/v.mp4" }] });
    expect(EvidencePack.parse(pack)).toEqual(pack);
    expect(pack.version).toBe(2);
    // unit stands for every check verifying ran until the checks are told apart (wave 12); e2e counts the manifest's rows.
    expect(pack.results).toEqual({ unit: { passed: 9, total: 10 }, integration: null, e2e: { verdict: "pass", passed: 2, total: 3 }, coverageDelta: { added: 20, covered: 18 } });
    expect(pack.findingsDetail).toEqual([
      { id: "F1", title: "total is not memoised", severity: "should_fix", resolution: "fixed" },
      { id: "F2", title: "naming", severity: "should_fix", resolution: null },
    ]);
    expect(pack.media[0]).toMatchObject({ url: "/state/evidence/t/abc/walk.mp4", localPath: "/state/evidence/t/abc/walk.mp4" });
    expect(pack.media[3]?.localPath).toBeUndefined();
  });

  it("leaves a pack without a Verify Report exactly as before, and a v1 pack parses", () => {
    const pack = assembleEvidencePack(full);
    for (const key of ["results", "findingsDetail", "version", "previewUrl"]) expect(pack).not.toHaveProperty(key);
    expect(pack.media.every((m) => m.localPath === undefined)).toBe(true);
    expect(EvidencePack.safeParse(pack).success).toBe(true);
  });
});

describe("assembleEvidencePack", () => {
  it("fills every section and is a valid EvidencePack", () => {
    const pack = assembleEvidencePack(full);
    expect(EvidencePack.parse(pack)).toEqual(pack);
    expect(pack).toMatchObject({ format: "captures", risk: "medium", rollback: "Revert the merge commit.", howToVerify: "open https://stg.example.com/cart", commitSha: "abc1234def5678", at: "2026-11-04T10:00:00.000Z" });
    expect(pack.scenarios).toEqual([
      { text: "Total shows after adding an item", test: "e2e/cart.spec.ts", result: "pass" },
      { text: "Total updates on removal", test: null, result: "partial" },
      { text: "Empty cart shows zero", test: null, result: "fail" },
    ]);
    expect(pack.outOfMap).toEqual(["web/format.ts: shared currency helper"]);
    expect(pack.media.map((m) => m.kind)).toEqual(["video", "screenshot", "report"]);
  });

  it("renders each finding as severity: title (path:line)", () => {
    expect(assembleEvidencePack(full).findings).toEqual(["should_fix: total is not memoised (web/cart.tsx:42)", "bug: NaN on empty (web/total.ts:7)"]);
  });

  it("writes one paragraph naming the goal, the scenario results, the format and the risk", () => {
    const { summary } = assembleEvidencePack(full);
    expect(summary).not.toContain("\n");
    for (const part of ["Show the cart total in the header", "3 scenarios", "1 passed", "1 partial", "1 failed", "captures", "medium"]) expect(summary).toContain(part);
  });

  it("falls back to the task title without a record, and says so when there are no scenarios in the text format", () => {
    const pack = assembleEvidencePack({ ...full, record: null, scenarios: [], media: [], format: "text", plan: { risk: null } });
    expect(pack.summary).toContain("Cart total");
    expect(pack.summary).toContain("No browser scenarios");
    expect(pack.summary).toContain("text");
    expect(pack.media).toEqual([]);
  });

  it("takes the risk from the plan, else the record, else medium; and a rollback default when the plan has none", () => {
    expect(assembleEvidencePack({ ...full, plan: { risk: null } }).risk).toBe("low");
    expect(assembleEvidencePack({ ...full, record: null, plan: { risk: null } }).risk).toBe("medium");
    expect(assembleEvidencePack({ ...full, plan: { risk: "high" } }).rollback).toMatch(/revert/i);
  });

  it("keeps a note and a video when given, and drops neither for a captures pack", () => {
    const video = { file: "walkthrough.mp4", durationS: 80, verdict: "ship" as const, scores: { hook: 9 }, defects: [], rounds: 1 };
    const pack = assembleEvidencePack({ ...full, format: "video", note: "n", video });
    expect(pack).toMatchObject({ format: "video", note: "n", video });
    expect(assembleEvidencePack(full)).not.toHaveProperty("note");
    expect(assembleEvidencePack(full)).not.toHaveProperty("video");
  });
});

describe("packComplete", () => {
  const base = (): EvidencePack => assembleEvidencePack({ ...full, media: [{ kind: "screenshot", label: "a.png", url: "https://github.com/o/a/releases/download/t/a.png" }] });
  const never = () => false;

  it("is ok for a full pack whose commit is the head", () => {
    expect(packComplete(base(), "abc1234def5678", never)).toEqual({ ok: true, problems: [] });
  });

  it("names a commit that is not the head", () => {
    const result = packComplete(base(), "fff9999", never);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("abc1234")]);
    expect(result.problems[0]).toContain("fff9999");
  });

  it("names each missing section", () => {
    const empty = { ...base(), summary: " ", rollback: "", howToVerify: "", scenarios: [] };
    const { ok, problems } = packComplete(empty, "abc1234def5678", never);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/summary/);
    expect(problems.join("\n")).toMatch(/rollback/);
    expect(problems.join("\n")).toMatch(/how to verify/i);
    expect(problems.join("\n")).toMatch(/scenarios/);
  });

  it("asks for no scenarios in the text format", () => {
    expect(packComplete({ ...base(), format: "text", media: [], scenarios: [] }, "abc1234def5678", never).ok).toBe(true);
  });

  it("wants every media url non-empty and a local path to exist", () => {
    const pack = { ...base(), media: [{ kind: "screenshot" as const, label: "a.png", url: "" }, { kind: "screenshot" as const, label: "b.png", url: "/state/evidence/t/abc/b.png" }, { kind: "screenshot" as const, label: "c.png", url: "/state/evidence/t/abc/c.png" }] };
    const result = packComplete(pack, "abc1234def5678", (path) => path.endsWith("b.png"));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("a.png"), expect.stringContaining("c.png")]);
  });
});
