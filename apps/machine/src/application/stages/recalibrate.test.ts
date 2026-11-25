import { type Finding, findingId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { Decide } from "./check-decide.ts";
import { recalibrateSeverity } from "./recalibrate.ts";

const finding = (severity: string, line: number): Finding => ({ path: "a.ts", line, severity, title: `t${line}`, body: "b", confidence: 0.8 });
const answer = (choice: string, p: number) => ({ severity: { choice, confidence: p } });
const deps = (table: Record<number, Record<string, unknown>>, seen: string[] = []) => ({
  decide: (async (pack, check) => (seen.push(pack), table[(check as { finding: Finding }).finding.line] ?? answer("should_fix", 0.9))) as Decide,
  repoPath: "/r",
  decisions: {},
  excerpt: async () => "code",
});

describe("recalibrateSeverity", () => {
  it("raises a nit-level finding to bug on a confident blocker and lowers a bug-level one to suggestion on a confident nit, recording each change", async () => {
    const seen: string[] = [];
    const fs = [finding("suggestion", 1), finding("question", 2), finding("bug", 3), finding("test", 4), finding("api-surface", 5), finding("nit", 6)];
    const out = await recalibrateSeverity(deps({ 1: answer("blocker", 0.95), 2: answer("blocker", 0.9), 3: answer("nit", 0.95), 4: answer("nit", 0.9), 5: answer("nit", 0.9), 6: answer("nit", 0.9) }, seen), fs);
    expect(out.findings.map((f) => f.severity)).toEqual(["bug", "bug", "suggestion", "suggestion", "suggestion", "nit"]);
    expect(out.changes).toEqual([
      { id: findingId(fs[0]!), from: "suggestion", to: "bug" },
      { id: findingId(fs[1]!), from: "question", to: "bug" },
      { id: findingId(fs[2]!), from: "bug", to: "suggestion" },
      { id: findingId(fs[3]!), from: "test", to: "suggestion" },
      { id: findingId(fs[4]!), from: "api-surface", to: "suggestion" },
    ]);
    expect(seen.every((p) => p === "finding_classify")).toBe(true);
    expect(out.findings[0]!.id).toBe(findingId(fs[0]!));
  });

  it("leaves should_fix, agreeing answers, flagged answers and unasked findings alone", async () => {
    const fs = [finding("bug", 1), finding("suggestion", 2), finding("bug", 3), finding("suggestion", 4)];
    // line 1 agrees (blocker on a bug), 2 is should_fix, 3 is a middling nit (a flag, under the proceed bar), 4 has no answer.
    const out = await recalibrateSeverity(deps({ 1: answer("blocker", 0.95), 2: answer("should_fix", 0.95), 3: answer("nit", 0.6), 4: {} }), fs);
    expect(out.findings.map((f) => f.severity)).toEqual(["bug", "suggestion", "bug", "suggestion"]);
    expect(out.changes).toEqual([]);
    const none = await recalibrateSeverity({ ...deps({}), decide: null }, fs);
    expect(none.findings).toEqual(fs);
    expect(none.changes).toEqual([]);
  });

  it("lowers a security finding only on a very confident nit, and never raises one", async () => {
    const fs = [finding("security", 1), finding("security", 2)];
    const out = await recalibrateSeverity(deps({ 1: answer("nit", 0.8), 2: answer("nit", 0.97) }), fs);
    expect(out.findings.map((f) => f.severity)).toEqual(["security", "suggestion"]);
    expect(out.changes).toEqual([{ id: findingId(fs[1]!), from: "security", to: "suggestion" }]);
  });
});
