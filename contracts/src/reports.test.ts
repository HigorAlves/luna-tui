import { describe, expect, it } from "vitest";

import { BuildReport, TaskReports, VerifyReport } from "./reports.ts";
import { EvidencePack } from "./stage.ts";

const build = {
  branch: "luna/x",
  base: null,
  headSha: "abc",
  envHash: null,
  diffSummary: { added: 12, removed: 3, files: ["src/a.ts"] },
  declaredFiles: [{ path: "src/b.ts", reason: "shared type" }],
  tests: [],
  runs: [{ attempt: 1, outcome: "pass", engine: "claude:sonnet", durationMs: 90_000 }],
  tokens: null,
  minutes: 1.5,
  scopeCheck: { clean: true, issues: [] },
  version: 2,
};

const verify = {
  prNumber: 7,
  headSha: "abc",
  findings: [{ path: "src/a.ts", line: 3, severity: "bug", title: "t", body: "b", confidence: 0.8, id: "F1", resolution: { status: "fixed", by: "implementer", commit: "def" } }],
  tests: { passed: 4, total: 4 },
  coverageDelta: { files: [], total: { added: 10, covered: 9 }, report: "coverage/lcov.info" },
  e2e: { verdict: "pass", scenarios: [{ text: "s", result: "pass" }], artifacts: [] },
  envReproduction: null,
  overrides: [],
  version: 2,
};

describe("the v2.2 reports", () => {
  it("round-trips a Build Report, nulls for what no wave fills yet", () => {
    expect(BuildReport.parse(JSON.parse(JSON.stringify(build)))).toEqual(build);
    expect(BuildReport.safeParse({ ...build, scopeCheck: { clean: "yes" } }).success).toBe(false);
  });

  it("round-trips a Verify Report with v2 findings and a resolution", () => {
    expect(VerifyReport.parse(JSON.parse(JSON.stringify(verify)))).toEqual(verify);
    expect(VerifyReport.safeParse({ ...verify, findings: [{ path: "x" }] }).success).toBe(false);
  });

  it("holds both under reports, each nullable", () => {
    expect(TaskReports.parse({ build, verify: null })).toEqual({ build, verify: null });
  });
});

describe("evidence pack v2", () => {
  const v1 = {
    summary: "s",
    format: "captures",
    scenarios: [{ text: "a", test: null, result: "pass" }],
    findings: [],
    outOfMap: [],
    risk: "low",
    rollback: "revert",
    howToVerify: "run it",
    commitSha: "abc",
    media: [{ kind: "screenshot", label: "one", url: "/tmp/one.png" }],
    at: "2026-11-01T00:00:00.000Z",
  };

  it("parses a pack made before v2.2 unchanged", () => {
    expect(EvidencePack.parse(v1)).toEqual(v1);
  });

  it("accepts results, findingsDetail, previewUrl, a local path and a version", () => {
    const v2 = {
      ...v1,
      media: [{ ...v1.media[0], localPath: "/tmp/one.png" }],
      results: { unit: { passed: 4, total: 4 }, integration: null, e2e: { verdict: "pass", passed: 1, total: 1 }, coverageDelta: { added: 10, covered: 9 } },
      findingsDetail: [{ id: "F1", title: "t", severity: "bug", resolution: "fixed" }],
      previewUrl: "https://preview.example/x",
      version: 2,
    };
    expect(EvidencePack.parse(v2)).toEqual(v2);
  });
});
