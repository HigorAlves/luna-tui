import { describe, expect, it } from "vitest";

import { byDirectory, findingCounts, shardedSummary } from "./review-summary.ts";

describe("the summary of a review read in parts", () => {
  const base = {
    title: "GR-1577: Merge Particle individual record export epic into master",
    parts: { reviewed: 8, of: 8 },
    files: 84,
    lines: 21_340,
    skipped: 12,
    findings: [] as Array<{ severity: string }>,
    against: { tickets: [] as string[], cards: [] as string[] },
    unreviewed: [] as Array<{ path: string; lines: number }>,
    capped: 0,
    failed: 0,
  };

  it("reads as one review of the whole PR: its title, the parts, the size, what was skipped, the counts and what it was checked against", () => {
    const text = shardedSummary({ ...base, findings: [{ severity: "bug" }, { severity: "question" }, { severity: "bug" }] });
    expect(text).toBe(
      "GR-1577: Merge Particle individual record export epic into master, reviewed in 8 parts by module (84 files, 21,340 lines; 12 lock or generated files skipped). 3 findings: 2 bugs, 1 question. No Jira ticket or board card linked; reviewed against the PR description.",
    );
    expect(text).not.toMatch(/shard/i);
  });

  it("says no findings plainly, and names the tickets and cards it was checked against", () => {
    const text = shardedSummary({ ...base, skipped: 0, against: { tickets: ["GR-1577"], cards: ["31348d24"] } });
    expect(text).toContain("(84 files, 21,340 lines). No findings.");
    expect(text).toContain("Reviewed against GR-1577 and card 31348d24.");
  });

  it("groups what was not read by folder instead of listing every file, and says why", () => {
    const unreviewed = [
      ...Array.from({ length: 8 }, (_, i) => ({ path: `gatherapi/services/s${i}.py`, lines: 300 })),
      ...Array.from({ length: 5 }, (_, i) => ({ path: `migrations/versions/m${i}.py`, lines: 80 })),
      { path: ".github/workflows/ci.yml", lines: 145 },
      { path: "config/default.cfg", lines: 84 },
    ];
    const text = shardedSummary({ ...base, parts: { reviewed: 1, of: 8 }, unreviewed, failed: 7 });
    expect(text).toContain("reviewed 1 of 8 parts by module");
    expect(text).toContain("Not reviewed: 15 files in 7 parts that did not finish, in gatherapi/services/ (8 files), migrations/versions/ (5), .github/workflows/ (1) and config/ (1).");
    expect(text).not.toContain("s3.py");
  });

  it("tells parts over the cap from parts that failed", () => {
    const text = shardedSummary({ ...base, parts: { reviewed: 25, of: 30 }, unreviewed: [{ path: "docs/a.md", lines: 10 }], capped: 5 });
    expect(text).toContain("Not reviewed: 1 file in 5 parts over the review.max_shards cap, in docs/ (1 file).");
  });
});

describe("byDirectory", () => {
  it("shows the biggest folders first and folds the rest", () => {
    const rows = ["a/1", "a/2", "a/3", "b/1", "b/2", "c/1", "d/1", "e/1", "f/1", "g/1"].map((path) => ({ path, lines: 1 }));
    expect(byDirectory(rows, 3)).toBe("a/ (3 files), b/ (2), c/ (1) and 4 more folders");
  });

  it("puts a file at the top level under the PR's root", () => {
    expect(byDirectory([{ path: "README.md" }])).toBe("the root (1 file)");
  });
});

describe("findingCounts", () => {
  it("counts by severity, gravest first", () => {
    expect(findingCounts([{ severity: "nit" }, { severity: "security" }, { severity: "suggestion" }, { severity: "suggestion" }])).toBe("4 findings: 1 security, 2 suggestions, 1 nit.");
    expect(findingCounts([])).toBe("No findings.");
    expect(findingCounts([{ severity: "api-surface" }])).toBe("1 finding: 1 api-surface.");
  });
});
