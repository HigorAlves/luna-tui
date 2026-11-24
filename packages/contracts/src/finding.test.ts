import { describe, expect, it } from "vitest";

import { findingId, mergeDuplicateFindings, normaliseFinding, severityOf } from "./finding.ts";
import { Finding } from "./stage.ts";

const base = { path: "src/a.ts", line: 10, severity: "bug", title: "Null deref", body: "x may be null", confidence: 0.6 };

describe("finding v2", () => {
  it("maps a severity string to a level by the calibration table", () => {
    for (const s of ["bug", "security", "blocker", "BLOCKER", " Bug ", "critical", "high", "major", "error"]) expect(severityOf(s)).toBe("blocker");
    for (const s of ["test", "perf", "question", "should_fix", "medium", "moderate", "warning"]) expect(severityOf(s)).toBe("should_fix");
    for (const s of ["nit", "low", "minor", "style", "info", "nitpick", "suggestion", "NIT"]) expect(severityOf(s)).toBe("nit");
  });

  it("reads a severity it does not know as should_fix, never as a nit", () => {
    for (const s of ["", "whatever", "scope", "catastrophic"]) expect(severityOf(s)).toBe("should_fix");
  });

  it("gives a finding a short stable id from path, line and title", () => {
    const id = findingId(base);
    expect(id).toMatch(/^F[0-9a-f]{8}$/);
    const reworded = { ...base, body: "other", confidence: 0.1 };
    expect(findingId(reworded)).toBe(id);
    expect(findingId({ ...base, line: 11 })).not.toBe(id);
    expect(findingId({ ...base, path: "src/b.ts" })).not.toBe(id);
    expect(findingId({ ...base, title: "Other" })).not.toBe(id);
  });

  it("normalises a v1 finding: id, level, suggested fix from suggestion_code, description from body", () => {
    expect(Finding.safeParse(base).success).toBe(true);
    const n = normaliseFinding({ ...base, suggestion_code: "if (x) {}" });
    expect(n).toMatchObject({ id: findingId(base), suggested_fix: "if (x) {}", description: "x may be null", severity: "bug" });
    // the explicit v2 values win
    expect(normaliseFinding({ ...base, id: "mine", suggested_fix: "fix", description: "d", suggestion_code: "old" })).toMatchObject({ id: "mine", suggested_fix: "fix", description: "d" });
    expect(normaliseFinding(base).suggested_fix).toBeNull();
  });

  it("accepts the v2 fields: a category, a criterion, a resolution", () => {
    const f = { ...base, category: "security", criterion_ref: "C1", resolution: { status: "fixed", by: "implementer", commit: "abc" } };
    expect(Finding.parse(f)).toEqual(f);
    expect(Finding.safeParse({ ...base, category: "vibes" }).success).toBe(false);
  });

  it("merges findings on the same path within 3 lines with the same title: highest severity and confidence, merged ids", () => {
    const a = { ...base, line: 10, severity: "nit", confidence: 0.4 };
    const b = { ...base, line: 12, severity: "bug", confidence: 0.9 };
    const c = { ...base, path: "src/z.ts", line: 1, title: "Other", severity: "test" };
    const out = mergeDuplicateFindings([a, c, b]);
    expect(out).toHaveLength(2);
    // order kept: the merged finding sits where its first member was
    expect(out[0]).toMatchObject({ path: "src/a.ts", line: 10, severity: "bug", confidence: 0.9, merged: [findingId(b)] });
    expect(out[1]).toMatchObject({ path: "src/z.ts" });
    expect(out[1]?.merged).toBeUndefined();
  });

  it("keeps a blocker a blocker when it is merged with a nit, in either order", () => {
    const blocker = { ...base, severity: "critical", line: 10 };
    const nit = { ...base, severity: "nit", line: 11 };
    expect(mergeDuplicateFindings([blocker, nit])[0]?.severity).toBe("critical");
    expect(mergeDuplicateFindings([nit, blocker])[0]?.severity).toBe("critical");
    expect(severityOf(mergeDuplicateFindings([nit, blocker])[0]!.severity)).toBe("blocker");
  });

  it("a finding raised again drops a resolution the machine inferred, and keeps one a stage set", () => {
    const inferred = { status: "fixed" as const, by: "implementer", inferred: true };
    const set = { status: "dismissed" as const, by: "owner" };
    expect(mergeDuplicateFindings([{ ...base, line: 10, resolution: inferred }, { ...base, line: 11 }])[0]?.resolution).toBeUndefined();
    expect(mergeDuplicateFindings([{ ...base, line: 10, resolution: set }, { ...base, line: 11 }])[0]?.resolution).toEqual(set);
  });

  it("does not merge across paths, beyond 3 lines, or with different titles; a title match ignores case and spacing", () => {
    expect(mergeDuplicateFindings([base, { ...base, line: 14 }])).toHaveLength(2);
    expect(mergeDuplicateFindings([base, { ...base, path: "src/b.ts" }])).toHaveLength(2);
    expect(mergeDuplicateFindings([base, { ...base, title: "Different" }])).toHaveLength(2);
    expect(mergeDuplicateFindings([base, { ...base, line: 13, title: "  null  DEREF " }])).toHaveLength(1);
  });

  it("merges findings that share an id, and does not mutate its input", () => {
    const a = { ...base, id: "same" };
    const b = { ...base, id: "same", line: 40, title: "Another", severity: "security" };
    const input = [a, b];
    const out = mergeDuplicateFindings(input);
    expect(out).toHaveLength(1);
    expect(input).toEqual([a, b]);
  });
});
