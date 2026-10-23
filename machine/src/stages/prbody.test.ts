import { describe, expect, it } from "vitest";

import type { TaskRow } from "../db/entities.ts";
import { buildPr } from "./prbody.ts";

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
    expect(body).toContain("- [ ] a");
    expect(body).not.toMatch(/claude|generated with|co-authored|anthropic|\bAI\b/i);
  });

  it("falls back to the description without a plan and caps the title at 60", () => {
    const long = "x".repeat(80);
    const pr = buildPr({ task: task({ title: long }), plan: null, repoSlug: null });
    expect(pr.title).toHaveLength(60);
    expect(pr.body).toContain("- desc");
  });
});
