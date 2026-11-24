import { describe, expect, it } from "vitest";

import { AGENT_PACKS, DocsDriftAnswer, DocsDriftContext, PACKS, PackId } from "./index.ts";

const entry = { doc: "docs/configuration.md", section: "Variables", why: "The change renamed MACHINE_PORT.", suggestion: "Rename it in the table." };

describe("DocsDriftContext", () => {
  const context = { repo: "acme/api", changedFiles: ["src/config.ts"], docFiles: ["docs/configuration.md", "README.md"] };

  it("reads a repo, the files the change touched and the repo's doc files", () => {
    expect(DocsDriftContext.parse(context)).toEqual(context);
    expect(DocsDriftContext.safeParse({ ...context, repo: "acme" }).success).toBe(false);
  });

  it("caps the doc files at two hundred and the changed files at five hundred", () => {
    expect(DocsDriftContext.safeParse({ ...context, docFiles: Array.from({ length: 200 }, (_, i) => `docs/${i}.md`) }).success).toBe(true);
    expect(DocsDriftContext.safeParse({ ...context, docFiles: Array.from({ length: 201 }, (_, i) => `docs/${i}.md`) }).success).toBe(false);
    expect(DocsDriftContext.safeParse({ ...context, changedFiles: Array.from({ length: 501 }, (_, i) => `a${i}.ts`) }).success).toBe(false);
  });
});

describe("DocsDriftAnswer", () => {
  it("lists the stale sections, at most ten, each with a why and a suggestion of at most 300 characters", () => {
    expect(DocsDriftAnswer.parse({ stale: [entry, { ...entry, section: null }] }).stale).toHaveLength(2);
    expect(DocsDriftAnswer.safeParse({ stale: [] }).success).toBe(true);
    expect(DocsDriftAnswer.safeParse({ stale: Array.from({ length: 11 }, () => entry) }).success).toBe(false);
    expect(DocsDriftAnswer.safeParse({ stale: [{ ...entry, why: "x".repeat(301) }] }).success).toBe(false);
    expect(DocsDriftAnswer.safeParse({ stale: [{ ...entry, suggestion: "x".repeat(301) }] }).success).toBe(false);
  });
});

describe("the docs_drift pack", () => {
  it("is a read-only haiku agent pack with a small budget", () => {
    expect(PackId.options).toContain("docs_drift");
    expect(AGENT_PACKS.map((p) => p.id)).toContain("docs_drift");
    expect(PACKS.docs_drift).toMatchObject({ kind: "agent", agent: "docs-keeper", helpers: [], writable: false, effort: "low", engines: { default: "claude:haiku", allowed: ["claude:haiku", "claude:sonnet"] }, template: "docs_drift.md" });
    expect(PACKS.docs_drift.access).toMatchObject({ read: true, write: false });
    expect(PACKS.docs_drift.maxTurns).toBeLessThanOrEqual(15);
  });
});
