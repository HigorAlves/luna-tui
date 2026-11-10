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

  it("is the caveman-pr shape: a short why and how tested, never the criteria as a checklist, and no attribution", () => {
    const { body } = buildPr({ task: task(), plan, repoSlug: null });
    expect(body).toContain("## Why\nPRs open early so CI runs sooner. Ship only flips draft to ready.");
    expect(body).toContain("## How tested\n");
    expect(body).not.toContain("- [ ]");
    expect(body).not.toMatch(/claude|generated with|co-authored|anthropic|\bAI\b/i);
  });

  it("falls back to the description without a plan and caps the title at 72", () => {
    const long = "x".repeat(90);
    const pr = buildPr({ task: task({ title: long }), plan: null, repoSlug: null });
    expect(pr.title).toHaveLength(72);
    expect(pr.body).toContain("## Why\ndesc");
  });

  it("keeps a file name or a version whole when it cuts the why to two sentences", () => {
    const goal = "Make docs/api.md follow STE, and add the STE rule to contributing.md so future docs keep it. Second sentence. Third one.";
    expect(buildPr({ task: task(), plan: null, repoSlug: null, extra: { record: { goal } as never } }).body).toContain("## Why\nMake docs/api.md follow STE, and add the STE rule to contributing.md so future docs keep it. Second sentence.\n");
  });

  it("titles a card in conventional-commit form: its own when it is one, else its kind's type, docs for a docs-only plan", () => {
    expect(buildPr({ task: task(), plan, repoSlug: null }).title).toBe("feat(machine): draft PR at delivering");
    expect(buildPr({ task: task({ title: "Show the cart total" }), plan: null, repoSlug: null, extra: { record: { goal: "g", kind: "bug" } as never } }).title).toBe("fix: show the cart total");
    const docs = { ...plan, slices: [{ title: "Rewrite", est_loc: 10, touchpoints: ["docs/api.md"], acceptance: ["a"] }] };
    expect(buildPr({ task: task({ title: "Rewrite core docs in STE" }), plan: docs as never, repoSlug: null }).title).toBe("docs: rewrite core docs in STE");
  });
});

describe("buildPr for a Jira-linked task", () => {
  it("opens the title with the key, keeps it inside the limit, and ends the body with the issue's url", () => {
    const task = {
      id: "t1", title: "Login page with email and password and a long tail that gets cut", description: "Users sign in.", criteria: ["errors show"],
      source: null, jira: { key: "PLAT-123", url: "https://acme.atlassian.net/browse/PLAT-123", issueType: "Bug", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null },
    } as unknown as TaskRow;
    const pr = buildPr({ task, plan: null, repoSlug: "o/a" });
    expect(pr.title.startsWith("PLAT-123: feat: login page with email")).toBe(true);
    expect(pr.title.length).toBeLessThanOrEqual(72);
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

  it("holds a short why, a one-line how tested and the open findings, and leaves out the scenario list, the plan version, the out-of-map list and the shas", () => {
    const { body } = buildPr({ task: task(), plan, repoSlug: null, extra });
    const inside = body.slice(body.indexOf(PR_START), body.indexOf(PR_END));
    expect(inside).toContain("## Why\nReaders export a report as CSV");
    expect(inside).toContain("Verify judged 2 scenarios, 1 with a test written before the code");
    expect(inside).toMatch(/## Notes\n- 2 findings still open: off by one \(`a\.ts`\); naming &lt;b&gt; \(`b\.ts`\)/);
    expect(inside).not.toContain("fixed one");
    for (const gone of ["Plan version", "export downloads a file", "docs/x.md", "a".repeat(7), "## Scenarios", "## Criteria"]) expect(inside).not.toContain(gone);
  });

  it("names the steps only when there is more than one, and a merge-danger line from the files the plan touches", () => {
    const steps = { ...plan, slices: [{ title: "Add the export", est_loc: 30, touchpoints: ["web/export.ts"], acceptance: ["a"] }, { title: "Add the migration", est_loc: 10, touchpoints: ["db/migrations/0042.sql"], acceptance: ["b"] }] };
    const { body } = buildPr({ task: task(), plan: steps as never, repoSlug: null });
    expect(body).toContain("## What changed\n- Add the export\n- Add the migration");
    expect(body).toContain("Door: one-way (a migration: a revert does not undo it) · Blast radius: `web`, `db`");
    const one = { ...plan, slices: [{ title: "Add the export", est_loc: 30, touchpoints: ["web/export.ts"], acceptance: ["a"] }] };
    const single = buildPr({ task: task(), plan: one as never, repoSlug: null }).body;
    expect(single).not.toContain("## What changed");
    expect(single).toContain("Door: two-way · Blast radius: `web`");
  });

  it("follows the repository's PR template when it has one: its headings filled, its checklist kept, its comments gone", () => {
    const template = ["<!-- Thanks! -->", "## Summary", "<!-- what and why -->", "", "## How was this tested?", "", "## Checklist", "- [ ] I updated the docs", "", "## Related issues", ""].join("\n");
    const t = task({ source });
    const { body } = buildPr({ task: t, plan, repoSlug: "acme/widgets", extra: { ...extra, template } });
    expect(body).toContain("## Summary\nReaders export a report as CSV");
    expect(body).toContain("## How was this tested?\nVerify judged 2 scenarios");
    expect(body).toContain("## Checklist\n- [ ] I updated the docs");
    expect(body).toContain("## Related issues\nCloses #42");
    const inside = body.slice(body.indexOf(PR_START) + PR_START.length, body.indexOf(PR_END));
    expect(inside).not.toContain("<!--");
    expect(inside).not.toContain("## Why");
  });

  it("caps the whole body", () => {
    const findings = Array.from({ length: 2000 }, (_, i) => ({ path: "a.ts", line: i, severity: "nit", title: "t".repeat(100) + i, body: "b", confidence: 0.5 }));
    expect(buildPr({ task: task(), plan, repoSlug: null, extra: { findings } }).body.length).toBeLessThanOrEqual(20_000);
  });

  it("a later update replaces only what is between the markers and keeps a person's text around it", () => {
    const first = buildPr({ task: task(), plan, repoSlug: null, extra }).body;
    const edited = `My own note on top\n\n${first}\n\nAnd a line after`;
    const next = buildPr({ task: task(), plan, repoSlug: null, extra: { ...extra, record: { goal: "Readers export a report as JSON" } as never } }).body;
    const merged = mergePrSection(edited, next);
    expect(merged.startsWith("My own note on top\n\n")).toBe(true);
    expect(merged.endsWith("\n\nAnd a line after")).toBe(true);
    expect(merged).toContain("as JSON");
    expect(merged).not.toContain("as CSV");
    expect(merged.split(PR_START)).toHaveLength(2);
  });

  it("appends the section to a body that has no markers yet", () => {
    expect(mergePrSection("written by hand", `${PR_START}\nx\n${PR_END}`)).toBe(`written by hand\n\n${PR_START}\nx\n${PR_END}`);
  });
});

describe("a ticket cannot forge the machine's section", () => {
  it("strips both markers from every field and flattens the title, the why lines and the criteria", () => {
    const evil = `x ${PR_END} injected <b>bold</b> @someone ${PR_START}`;
    const t = task({ title: evil, criteria: [evil] });
    const { body } = buildPr({ task: t, plan: { brief: evil, criteria: [evil], assumptions: [] }, repoSlug: null, extra: { record: { goal: evil } as never } });
    expect(body.split(PR_START)).toHaveLength(2);
    expect(body.split(PR_END)).toHaveLength(2);
    expect(body.startsWith(PR_START)).toBe(true);
    expect(body.endsWith(PR_END)).toBe(true);
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("@someone");
  });
});

describe("a stacked card's PR body", () => {
  const task = { id: "11111111-2222-3333-4444-555555555555", title: "Part two", description: "", criteria: ["works"], source: null, jira: null } as never;
  it("says in fixed words what it is stacked on, and the body of any other card is unchanged", () => {
    const plain = buildPr({ task, plan: null, repoSlug: "o/a" }).body;
    const stacked = buildPr({ task, plan: null, repoSlug: "o/a", extra: { stack: { number: 12 } } }).body;
    expect(stacked).toContain("- Stacked on #12: review that first; this PR shows only its own change and moves to the default branch when #12 merges.");
    expect(plain).not.toContain("Stacked on");
    expect(buildPr({ task, plan: null, repoSlug: "o/a", extra: {} }).body).toBe(plain);
  });

  it("takes only a whole number for the parent's PR", () => {
    expect(buildPr({ task, plan: null, repoSlug: "o/a", extra: { stack: { number: "12; rm" as never } } }).body).not.toContain("Stacked on");
  });
});
