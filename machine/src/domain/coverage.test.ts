import { describe, expect, it } from "vitest";

import { addedLineNumbers, parseLcov, patchCoverage } from "./coverage.ts";

const LCOV = ["TN:", "SF:/work/src/a.ts", "DA:10,1", "DA:11,3", "DA:12,0", "DA:13,2", "DA:20,5", "end_of_record", "SF:src/b.ts", "DA:1,0", "DA:2,1", "end_of_record", ""].join("\n");

describe("parseLcov", () => {
  it("maps each file's lines to their hits, strips /work/ and prefixes a relative path with the check's cwd", () => {
    const lcov = parseLcov(LCOV, { cwd: "pkg" });
    expect([...lcov.keys()]).toEqual(["src/a.ts", "pkg/src/b.ts"]);
    expect(lcov.get("src/a.ts")!.get(12)).toBe(0);
    expect(lcov.get("src/a.ts")!.get(11)).toBe(3);
    expect(lcov.get("pkg/src/b.ts")!.get(2)).toBe(1);
  });

  it("leaves a relative path alone without a cwd, and ignores lines outside a record", () => {
    const lcov = parseLcov("DA:1,1\nSF:x.ts\nDA:4,2\nend_of_record\nDA:9,9\n");
    expect([...lcov.keys()]).toEqual(["x.ts"]);
    expect([...lcov.get("x.ts")!.entries()]).toEqual([[4, 2]]);
  });
});

describe("addedLineNumbers", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +10,5 @@ fn",
    " ctx",
    "+one",
    "+two",
    " ctx",
    "-gone",
    "+three",
    "@@ -30,1 +40,2 @@",
    " ctx",
    "+four",
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1,1 +1,2 @@",
    " keep",
    "+added",
    "diff --git a/dead.ts b/dead.ts",
    "deleted file mode 100644",
    "--- a/dead.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-x",
    "-y",
    "",
  ].join("\n");

  it("lists the new-file line numbers of the + lines per file, follows a rename, and gives a deleted file none", () => {
    const added = addedLineNumbers(diff);
    expect(added.get("src/a.ts")).toEqual([11, 12, 14, 41]);
    expect(added.get("new.ts")).toEqual([2]);
    expect(added.has("dead.ts")).toBe(false);
  });
});

describe("patchCoverage", () => {
  it("counts the added lines the report lists, how many ran, and leaves out files the report lacks", () => {
    const lcov = parseLcov(LCOV);
    const added = new Map([["src/a.ts", [10, 11, 12, 13, 14]], ["src/missing.ts", [1, 2]]]);
    const summary = patchCoverage({ lcov, added, report: "coverage/lcov.info" });
    expect(summary.files).toEqual([{ path: "src/a.ts", added: 4, covered: 3, uncovered: [12] }]);
    expect(summary.total).toEqual({ added: 4, covered: 3 });
    expect(summary.report).toBe("coverage/lcov.info");
  });

  it("sums the total over files and caps the uncovered lines at 50", () => {
    const hits = new Map(Array.from({ length: 60 }, (_, i) => [i + 1, 0] as [number, number]));
    const lcov = new Map([["a.ts", hits], ["b.ts", new Map([[1, 1]])]]);
    const added = new Map([["a.ts", Array.from({ length: 60 }, (_, i) => i + 1)], ["b.ts", [1]]]);
    const summary = patchCoverage({ lcov, added, report: "r" });
    expect(summary.files[0]!.uncovered).toHaveLength(50);
    expect(summary.files[0]).toMatchObject({ added: 60, covered: 0 });
    expect(summary.total).toEqual({ added: 61, covered: 1 });
  });
});
