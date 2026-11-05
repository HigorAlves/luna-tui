import { describe, expect, it } from "vitest";

import type { TaskRow } from "./task.ts";
import { PR_END, PR_START, type PrExtra, buildPr, mergePrSection } from "./prbody.ts";

const task = (over: Partial<TaskRow> = {}) =>
  ({
    title: "feat(machine): draft PR at delivering",
    description: "desc",
    criteria: ["opens a draft", "ready at shipping"],
    source: null,
    ...over,
  }) as unknown as TaskRow;
const plan = { brief: "PRs open early so CI runs sooner.\nShip only flips draft to ready.", criteria: ["a", "b"], assumptions: [] };
const source = { kind: "github" as const, repo: "acme/widgets", number: 42, url: "https://github.com/acme/widgets/issues/42" };

describe("buildPr", () => {
  it("closes the issue only when the PR repo matches the source repo", () => {
    expect(buildPr({ task: task({ source }), plan, repoSlug: "acme/widgets" }).body).toContain("\nCloses #42");
    expect(buildPr({ task: task({ source }), plan, repoSlug: "ACME/Widgets" }).body).toContain("Closes #42");
    expect(buildPr({ task: task({ source }), plan, repoSlug: "other/repo" }).body).not.toContain("Closes");
    expect(buildPr({ task: task({ source }), plan, repoSlug: null }).body).not.toContain("Closes");
    expect(buildPr({ task: task(), plan, repoSlug: "acme/widgets" }).body).not.toContain("Closes");
  });

  it("carries the brief and the criteria, with no attribution", () => {
    const { body } = buildPr({ task: task(), plan, repoSlug: null });
    expect(body).toContain("- PRs open early so CI runs sooner.");
    expect(body).toContain("- Ship only flips draft to ready.");
    expect(body).toContain("- [ ] a (C1)");
    expect(body).not.toMatch(/claude|generated with|co-authored|anthropic|\bAI\b/i);
  });

  it("falls back to the description without a plan and caps the title at 60", () => {
    const long = "x".repeat(80);
    const pr = buildPr({ task: task({ title: long }), plan: null, repoSlug: null });
    expect(pr.title).toHaveLength(60);
    expect(pr.body).toContain("- desc");
  });
});

describe("buildPr for a Jira-linked task", () => {
  it("opens the title with the key, keeps it inside the limit, and ends the body with the issue's url", () => {
    const task = {
      id: "t1", title: "Login page with email and password and a long tail that gets cut", description: "Users sign in.", criteria: ["errors show"],
      source: null, jira: { key: "PLAT-123", url: "https://acme.atlassian.net/browse/PLAT-123", issueType: "Bug", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null },
    } as unknown as TaskRow;
    const pr = buildPr({ task, plan: null, repoSlug: "o/a" });
    expect(pr.title).toBe("PLAT-123: Login page with email and password and a long tail");
    expect(pr.title.length).toBeLessThanOrEqual(60);
    expect(pr.body.endsWith(`Jira: https://acme.atlassian.net/browse/PLAT-123\n${PR_END}`)).toBe(true);
    const imported = buildPr({ task: { ...task, jira: null, source: { kind: "jira", key: "PLAT-9", url: "https://acme.atlassian.net/browse/PLAT-9", issueType: null } } as unknown as TaskRow, plan: null, repoSlug: "o/a" });
    expect(imported.title.startsWith("PLAT-9: ")).toBe(true);
    expect(imported.body).not.toContain("Closes #");
  });
});

describe("the machine's section of the body", () => {
  const record = { goal: "Readers export a report as CSV" } as never;
  const extra: PrExtra = {
    record,
    planVersion: 2,
    scenarios: [{ id: "S1", title: "export downloads a file", criterion: "C1", test: "src/export.test.ts" }, { id: "S2", title: "empty report", criterion: null, test: null }],
    findings: [
      { path: "a.ts", line: 3, severity: "blocker", title: "off by one", body: "b", confidence: 0.9 },
      { path: "b.ts", line: 9, severity: "nit", title: "naming <b>", body: "b", confidence: 0.5 },
      { path: "c.ts", line: 1, severity: "blocker", title: "fixed one", body: "b", confidence: 0.9, resolution: { status: "fixed", by: "build" } },
    ],
    outOfMap: [{ path: "docs/x.md", reason: "the guide named the old flag" }],
    base: "a".repeat(40),
    head: "b".repeat(40),
  } as PrExtra;

  it("holds, between its markers, why, the plan's version and criteria by id, each scenario with its test, the open findings by level, the files outside the map and the commits", () => {
    const { body } = buildPr({ task: task(), plan, repoSlug: null, extra });
    const inside = body.slice(body.indexOf(PR_START), body.indexOf(PR_END));
    expect(inside).toContain("- Readers export a report as CSV");
    expect(inside).toContain("Plan version 2");
    expect(inside).toContain("- [ ] a (C1)");
    expect(inside).toContain("- S1 (C1): export downloads a file, test `src/export.test.ts`");
    expect(inside).toContain("- S2: empty report, no test tagged");
    expect(inside).toMatch(/### blocker\n- off by one \(a\.ts:3\)/);
    expect(inside).toContain("### nit\n- naming &lt;b&gt; (b.ts:9)");
    expect(inside).not.toContain("fixed one");
    expect(inside).toContain("- docs/x.md: the guide named the old flag");
    expect(inside).toContain(`Base ${"a".repeat(7)}, head ${"b".repeat(7)}`);
  });

  it("caps the whole body", () => {
    const findings = Array.from({ length: 2000 }, (_, i) => ({ path: "a.ts", line: i, severity: "nit", title: "t".repeat(100) + i, body: "b", confidence: 0.5 }));
    expect(buildPr({ task: task(), plan, repoSlug: null, extra: { findings } }).body.length).toBeLessThanOrEqual(20_000);
  });

  it("a later update replaces only what is between the markers and keeps a person's text around it", () => {
    const first = buildPr({ task: task(), plan, repoSlug: null, extra }).body;
    const edited = `My own note on top\n\n${first}\n\nAnd a line after`;
    const next = buildPr({ task: task(), plan, repoSlug: null, extra: { ...extra, planVersion: 3 } }).body;
    const merged = mergePrSection(edited, next);
    expect(merged.startsWith("My own note on top\n\n")).toBe(true);
    expect(merged.endsWith("\n\nAnd a line after")).toBe(true);
    expect(merged).toContain("Plan version 3");
    expect(merged).not.toContain("Plan version 2");
    expect(merged.split(PR_START)).toHaveLength(2);
  });

  it("appends the section to a body that has no markers yet", () => {
    expect(mergePrSection("written by hand", `${PR_START}\nx\n${PR_END}`)).toBe(`written by hand\n\n${PR_START}\nx\n${PR_END}`);
  });
});
