import { describe, expect, it } from "vitest";

import { addedLineNumbers, coverageFinding, mutationFinding, parseMutationScore, parseLcov, patchCoverage } from "./coverage.ts";

const LCOV = ["TN:", "SF:/work/src/a.ts", "DA:10,1", "DA:11,3", "DA:12,0", "DA:13,2", "DA:20,5", "end_of_record", "SF:src/b.ts", "DA:1,0", "DA:2,1", "end_of_record", ""].join("\n");

describe("parseLcov", () => {
  it("maps each file's lines to their hits, strips /work/ and prefixes a relative path with the check's cwd", () => {
    const lcov = parseLcov(LCOV, { cwd: "pkg" });
    expect([...lcov.keys()]).toEqual(["src/a.ts", "pkg/src/b.ts"]);
    expect(lcov.get("src/a.ts")!.get(12)).toBe(0);
    expect(lcov.get("src/a.ts")!.get(11)).toBe(3);
    expect(lcov.get("pkg/src/b.ts")!.get(2)).toBe(1);
  });

  it("strips the worktree's own path too: a check run on the host (no runner image) writes absolute host paths", () => {
    const lcov = parseLcov("SF:/Users/me/wt/pkg/src/c.ts\nDA:3,1\nend_of_record\nSF:/elsewhere/d.ts\nDA:1,1\nend_of_record\n", { cwd: "pkg", root: "/Users/me/wt/" });
    expect([...lcov.keys()]).toEqual(["pkg/src/c.ts", "/elsewhere/d.ts"]);
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

describe("coverageFinding", () => {
  const summary = { files: [{ path: "src/a.ts", added: 4, covered: 1, uncovered: [2, 3, 4] }, { path: "src/b.ts", added: 2, covered: 2, uncovered: [] }], total: { added: 6, covered: 3 }, report: "coverage/lcov.info" };
  it("is a should_fix finding of category tests naming the uncovered files when patch coverage is below 1 - coverage_drop_max", () => {
    expect(coverageFinding(summary, 0.2)).toMatchObject({ severity: "should_fix", category: "tests", path: "src/a.ts", line: 2 });
    expect(coverageFinding(summary, 0.2)!.body).toBe("3 of 6 added lines are covered (50%), below the 80% the repository asks for\nuncovered: src/a.ts (2, 3, 4)");
  });
  it("is null at or above the threshold, and when nothing was added", () => {
    expect(coverageFinding(summary, 0.5)).toBeNull();
    expect(coverageFinding({ ...summary, total: { added: 0, covered: 0 }, files: [] }, 0)).toBeNull();
  });
  it("reads a coverage_drop_max above 1 as a percentage", () => {
    expect(coverageFinding(summary, 20)).not.toBeNull();
    expect(coverageFinding(summary, 60)).toBeNull();
  });
});

describe("the mutation score", () => {
  it("is read from the last `mutation score: <n>` line of the output, a fraction or a percentage", () => {
    expect(parseMutationScore("run\nmutation score: 0.82\n")).toBe(0.82);
    expect(parseMutationScore("Mutation-Score = 71.5%\nmutation score: 64%")).toBe(0.64);
  });
  it("is null when no line says it, or the number is out of range", () => {
    expect(parseMutationScore("all killed")).toBeNull();
    expect(parseMutationScore("mutation score: 7")).toBeNull();
    expect(parseMutationScore("mutation score: 140%")).toBeNull();
  });
  it("makes a should_fix finding of category tests under the minimum, none at or over it", () => {
    expect(mutationFinding(0.4, 0.6)).toMatchObject({ severity: "should_fix", category: "tests", title: "mutation score 40% is below the 60% the repository asks for" });
    expect(mutationFinding(0.6, 0.6)).toBeNull();
  });
});

describe("parseMutationScore against hostile output", () => {
  it("parses a multi-megabyte output of newlines or spaces in milliseconds, and still finds the last score line", () => {
    for (const filler of ["\n", " ", " \n", "\t \t"]) {
      const output = `mutation score: 0.5\n${filler.repeat(3_000_000 / filler.length)}mutation score: 0.7${filler.repeat(10)}`;
      const started = Date.now();
      expect(parseMutationScore(output)).toBe(0.7);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
  it("reads only the last 64 KiB, so a score line buried under megabytes is not found", () => {
    expect(parseMutationScore(`mutation score: 0.9\n${"x\n".repeat(200_000)}`)).toBeNull();
  });
});
