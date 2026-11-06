import { type BuildReport, EvidencePack, type Finding, type VerifyReport } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_HOW_TO_VERIFY, DEFAULT_ROLLBACK, assembleEvidencePack, packComplete, repairPack } from "./evidence-pack.ts";

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

const build = (over: Partial<BuildReport> = {}): BuildReport => ({
  branch: "b", base: null, headSha: "abc1234def5678", envHash: null,
  diffSummary: { added: 40, removed: 6, files: ["web/cart.tsx", "web/total.ts"] },
  declaredFiles: [], tests: [], runs: [], tokens: null, minutes: 3, scopeCheck: { clean: true, issues: [] }, version: 2,
  ...over,
});

describe("assembleEvidencePack with the Build Report and the layers", () => {
  const layered = [
    { id: "S1", layer: "unit" as const, text: "a", criterion: null, result: "pass" as const, test: "shot.png" },
    { id: "S2", layer: "unit" as const, text: "b", criterion: null, result: "pass" as const, test: null },
    { id: "S3", layer: "integration" as const, text: "c", criterion: null, result: "pass" as const, test: null },
    { id: "S4", layer: "e2e" as const, text: "d", criterion: null, result: "pass" as const, test: "row.png" },
  ];
  const tests = [
    { scenario: "S1", before: "fail" as const, after: "pass" as const, file: "src/a.test.ts" },
    { scenario: "S2", before: "fail" as const, after: "fail" as const, file: "src/b.test.ts" },
    { scenario: "S3", before: "fail" as const, after: "pass" as const, file: null },
  ];

  it("counts unit and integration by the scenarios' layer and their tagged tests' after: pass", () => {
    const pack = assembleEvidencePack({ ...full, scenarios: layered, verifyReport, buildReport: build({ tests }) });
    expect(pack.results).toMatchObject({ unit: { passed: 1, total: 2 }, integration: { passed: 1, total: 1 }, e2e: { verdict: "pass", passed: 2, total: 3 } });
  });

  it("keeps the checks total as unit when no scenario carries a layer", () => {
    const pack = assembleEvidencePack({ ...full, verifyReport, buildReport: build({ tests }) });
    expect(pack.results).toMatchObject({ unit: { passed: 9, total: 10 }, integration: null });
  });

  it("takes e2e from the browser run's rows when the report has them", () => {
    const rows = [{ scenario: "S1", title: "a", result: "pass", seen: "", artifacts: [] }, { scenario: "S2", title: "b", result: "not_run", seen: "", artifacts: [] }];
    const pack = assembleEvidencePack({ ...full, verifyReport: { ...verifyReport, e2e: { ...verifyReport.e2e, rows } } });
    expect(pack.results?.e2e).toEqual({ verdict: "pass", passed: 1, total: 2 });
  });

  it("names a scenario's test by the Build Report's file, else the row's first artifact", () => {
    const pack = assembleEvidencePack({ ...full, scenarios: layered, buildReport: build({ tests }) });
    expect(pack.scenarios.map((s) => s.test)).toEqual(["src/a.test.ts", "src/b.test.ts", null, "row.png"]);
  });

  it("carries the diff summary from the Build Report, and none without one", () => {
    const summary = { what: "Adds the total", why: "The ticket", files: [{ path: "web/cart.tsx", reason: null, in_code_map: true }], flags_added: [], migrations: [], risks_noticed: [], deps_added: [], todos: [] };
    const pack = assembleEvidencePack({ ...full, buildReport: build({ summary }) });
    expect(pack.diffSummary).toEqual({ what: "Adds the total", why: "The ticket", files: ["web/cart.tsx", "web/total.ts"], added: 40, removed: 6 });
    expect(assembleEvidencePack({ ...full, buildReport: build() }).diffSummary).toMatchObject({ what: "", why: "" });
    expect(assembleEvidencePack(full)).not.toHaveProperty("diffSummary");
    expect(EvidencePack.safeParse(pack).success).toBe(true);
  });

  it("numbers the revision: 1 for a first pack, the stored one plus one after", () => {
    expect(assembleEvidencePack(full).revision).toBe(1);
    expect(assembleEvidencePack({ ...full, previous: { revision: 3 } }).revision).toBe(4);
    expect(assembleEvidencePack({ ...full, previous: {} }).revision).toBe(2);
  });

  it("cuts a long summary at a word, to 200 words, and says not_run scenarios", () => {
    const goal = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const pack = assembleEvidencePack({ ...full, record: { ...record, goal } });
    const words = pack.summary.split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(200);
    expect(pack.summary).not.toMatch(/w\d+…$/);
    expect(assembleEvidencePack({ ...full, scenarios: [{ text: "a", criterion: null, result: "not_run", test: null }] }).summary).toContain("1 not run");
  });
});

describe("repairPack", () => {
  const head = "abc1234def5678";
  const base = (): EvidencePack => assembleEvidencePack({ ...full, media: [] });
  const never = () => false;

  it("rebuilds an empty or over-long summary, defaults an empty rollback and how to verify, and notes each repair", () => {
    const broken = { ...base(), summary: " ", rollback: "", howToVerify: "" };
    const { problems } = packComplete(broken, head, never);
    const out = repairPack(broken, problems, never);
    expect(out.unfixed).toEqual([]);
    expect(out.pack.summary.trim()).not.toBe("");
    expect(out.pack.rollback).toBe(DEFAULT_ROLLBACK);
    expect(out.pack.howToVerify).toBe(DEFAULT_HOW_TO_VERIFY);
    expect(out.pack.note).toMatch(/summary/);
    expect(out.pack.note).toMatch(/rollback/);
    expect(packComplete(out.pack, head, never).ok).toBe(true);

    const long = { ...base(), summary: Array.from({ length: 260 }, (_, i) => `w${i}`).join(" ") };
    const fixed = repairPack(long, packComplete(long, head, never).problems, never);
    expect(fixed.pack.summary.split(/\s+/).length).toBeLessThanOrEqual(200);
    expect(packComplete(fixed.pack, head, never).ok).toBe(true);
  });

  it("drops a media entry missing on disk, and turns a captures or video pack with no scenario into text", () => {
    const pack = { ...base(), scenarios: [], format: "video" as const, media: [{ kind: "screenshot" as const, label: "a.png", url: "/state/a.png" }, { kind: "screenshot" as const, label: "b.png", url: "/state/b.png" }] };
    const exists = (path: string) => path.endsWith("b.png");
    const out = repairPack(pack, packComplete(pack, head, exists).problems, exists);
    expect(out.pack.media.map((m) => m.label)).toEqual(["b.png"]);
    expect(out.pack.format).toBe("text");
    expect(out.pack.note).toMatch(/a\.png/);
    expect(out.unfixed).toEqual([]);
  });

  it("never repairs a commit that is not the head, and returns it", () => {
    const pack = base();
    const out = repairPack(pack, packComplete(pack, "fff9999", never).problems, never);
    expect(out.unfixed).toEqual([expect.stringContaining("fff9999")]);
    expect(out.pack.commitSha).toBe(pack.commitSha);
  });

  it("changes nothing when there is nothing to fix", () => {
    const pack = base();
    expect(repairPack(pack, [], never)).toEqual({ pack, unfixed: [] });
  });
});
