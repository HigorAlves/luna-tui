import { describe, expect, it } from "vitest";

import { parseDiff } from "./review-diff.ts";
import { type Decide } from "./check-decide.ts";
import { checkCriteria, criteriaOf } from "./criteria-check.ts";

const DIFF = "diff --git a/src/export.ts b/src/export.ts\n--- a/src/export.ts\n+++ b/src/export.ts\n@@ -3,2 +3,4 @@\n ctx\n+const header = 'a,b';\n+rows.join(',');\n ctx2\ndiff --git a/docs/readme.md b/docs/readme.md\n--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1 +1,2 @@\n+one line\n x\n";
const files = parseDiff(DIFF);
const yes = { met: { value: true, p: 0.97 } };
const no = { met: { value: false, p: 0.03 } };
const unsure = { met: { value: true, p: 0.55 } };
const ticket = (key: string, acceptanceCriteria: string | null) => ({ key, url: `https://x/${key}`, type: "Story", status: "To Do", summary: "s", description: "d", acceptanceCriteria });
const run = (decide: Decide | null, over: { tickets?: ReturnType<typeof ticket>[]; cards?: Array<{ id: string; criteria: string[] }>; files?: typeof files } = {}) =>
  checkCriteria({ decide }, { tickets: over.tickets ?? [], cards: over.cards ?? [], files: over.files ?? files, repoPath: "/r" });

describe("the criteria of the linked tickets and cards", () => {
  it("splits a ticket's section into one criterion per line, bullets and checkboxes off, and takes a card's list as it is", () => {
    const list = criteriaOf([ticket("DISC-1", "- Rows are exported\n* [ ] Header is first\n1. It is a CSV\n\n  \n")], [{ id: "abcdef1234", criteria: ["Works offline"] }]);
    expect(list).toEqual([
      { source: "DISC-1", criterion: "Rows are exported" },
      { source: "DISC-1", criterion: "Header is first" },
      { source: "DISC-1", criterion: "It is a CSV" },
      { source: "card abcdef12", criterion: "Works offline" },
    ]);
  });

  it("has none for a ticket with no criteria section, and caps the list", () => {
    expect(criteriaOf([ticket("DISC-1", null)], [])).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `- criterion ${i}`).join("\n");
    expect(criteriaOf([ticket("DISC-1", many)], [])).toHaveLength(20);
  });
});

describe("checking each criterion against the diff", () => {
  const asked: Array<{ pack: string; check: Record<string, unknown> }> = [];
  const by = (answers: Record<string, unknown>[]): Decide => {
    let i = 0;
    return (async (pack, check) => (asked.push({ pack, check: check as never }), answers[i++] ?? yes)) as Decide;
  };

  it("runs nothing when no ticket or card has a criterion", async () => {
    const out = await run(by([]), { tickets: [ticket("DISC-1", null)] });
    expect(out).toEqual({ results: [], findings: [], comments: [] });
  });

  it("asks criteria_met once per criterion with the criterion as data, the files and the diff", async () => {
    asked.length = 0;
    await run(by([yes]), { tickets: [ticket("DISC-1", "- Rows are exported")] });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.pack).toBe("criteria_met");
    const c = (asked[0]!.check as { kind: string; criterion: { source: string; criterion: string; files: unknown[]; excerpt: string; partial: boolean } });
    expect(c.kind).toBe("criterion");
    expect(c.criterion.source).toBe("DISC-1");
    expect(c.criterion.criterion).toMatch(/^\[untrusted.*Rows are exported/);
    expect(c.criterion.files).toEqual([{ path: "src/export.ts", additions: 2, deletions: 0 }, { path: "docs/readme.md", additions: 1, deletions: 0 }]);
    expect(c.criterion.excerpt).toContain("rows.join");
    expect(c.criterion.partial).toBe(false);
  });

  it("ticks a criterion met, makes a confident no a bug on the first added line of the biggest file, and an unsure one a question", async () => {
    const out = await run(by([yes, no, unsure]), { tickets: [ticket("DISC-1", "- A\n- B\n- C")] });
    expect(out.results).toEqual([
      { source: "DISC-1", criterion: "A", verdict: "met" },
      { source: "DISC-1", criterion: "B", verdict: "unmet" },
      { source: "DISC-1", criterion: "C", verdict: "unsure" },
    ]);
    expect(out.findings).toEqual([
      expect.objectContaining({ path: "src/export.ts", line: 4, severity: "bug", title: "Criterion not met (DISC-1): B" }),
      expect.objectContaining({ path: "src/export.ts", line: 4, severity: "question", title: "Criterion unclear (DISC-1): C" }),
    ]);
    expect(out.comments.map((c) => c.path)).toEqual(["src/export.ts", "src/export.ts"]);
  });

  it("leaves a criterion unchecked, with no finding, when no decision can be made", async () => {
    for (const decide of [null, (async () => { throw new Error("jev down"); }) as Decide]) {
      const out = await run(decide, { tickets: [ticket("DISC-1", "- A")] });
      expect(out.results).toEqual([{ source: "DISC-1", criterion: "A", verdict: "unchecked" }]);
      expect(out.findings).toEqual([]);
    }
  });

  it("hands a big PR's decision the files that bear on the criterion, within the cap, and says the rest is only listed", async () => {
    asked.length = 0;
    const filler = Array.from({ length: 30 }, (_, i) => `diff --git a/pad/f${i}.ts b/pad/f${i}.ts\n--- a/pad/f${i}.ts\n+++ b/pad/f${i}.ts\n@@ -1 +1,300 @@\n${"+unrelated line of padding text\n".repeat(300)}`).join("");
    const big = parseDiff(filler + DIFF);
    await run(by([yes]), { tickets: [ticket("DISC-1", "- Rows are exported as a CSV header")], files: big });
    const c = (asked[0]!.check as { criterion: { excerpt: string; partial: boolean; files: unknown[] } }).criterion;
    expect(c.partial).toBe(true);
    expect(c.excerpt.length).toBeLessThanOrEqual(12_500);
    expect(c.excerpt).toContain("src/export.ts");
    expect(c.files.length).toBeLessThanOrEqual(200);
  });
});
