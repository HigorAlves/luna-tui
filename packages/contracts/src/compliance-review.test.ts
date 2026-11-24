import { describe, expect, it } from "vitest";

import { AGENT_PACKS, ComplianceReviewAnswer, ComplianceReviewContext, PACKS, ComplianceRegime, helperPack, helpersOn } from "./index.ts";

const finding = { path: "api/users.ts", line: 12, severity: "security", title: "Email in the request log", body: "The log line writes the user's email.", confidence: 0.9, regime: "gdpr", clause: "GDPR Art. 5(1)(c)", control: "Compliance/Controls/PRIV-LOG-01.md" };

describe("ComplianceReviewContext", () => {
  const context = { repo: "acme/api", regimes: ["soc2", "gdpr"], controls: [{ path: "Compliance/Controls/PRIV-LOG-01.md", text: "No personal data in logs." }] };

  it("reads a repo, its regimes and the wiki's control pages", () => {
    expect(ComplianceReviewContext.parse(context)).toEqual(context);
    expect(ComplianceReviewContext.safeParse({ ...context, regimes: ["pci"] }).success).toBe(false);
    expect(ComplianceReviewContext.safeParse({ ...context, repo: "acme" }).success).toBe(false);
  });

  it("caps the pages at forty and their text at two hundred thousand characters", () => {
    const page = (i: number) => ({ path: `Compliance/Controls/C-${i}.md`, text: "x" });
    expect(ComplianceReviewContext.safeParse({ ...context, controls: Array.from({ length: 40 }, (_, i) => page(i)) }).success).toBe(true);
    expect(ComplianceReviewContext.safeParse({ ...context, controls: Array.from({ length: 41 }, (_, i) => page(i)) }).success).toBe(false);
    expect(ComplianceReviewContext.safeParse({ ...context, controls: [{ path: "Compliance/a.md", text: "x".repeat(100_001) }, { path: "Compliance/b.md", text: "x".repeat(100_000) }] }).success).toBe(false);
  });
});

describe("ComplianceReviewAnswer", () => {
  it("is the review contract's finding with the regime, the clause and the company's control", () => {
    const answer = { summary: "One GDPR finding.", findings: [finding], regimesRun: ["gdpr"] };
    expect(ComplianceReviewAnswer.parse(answer)).toEqual(answer);
    expect(ComplianceReviewAnswer.safeParse({ ...answer, findings: [{ ...finding, control: null }] }).success).toBe(true);
  });

  it("refuses a finding with no clause or an unknown regime", () => {
    const { clause: _clause, ...noClause } = finding;
    expect(ComplianceReviewAnswer.safeParse({ summary: "s", findings: [noClause], regimesRun: [] }).success).toBe(false);
    expect(ComplianceReviewAnswer.safeParse({ summary: "s", findings: [{ ...finding, regime: "pci" }], regimesRun: [] }).success).toBe(false);
    expect(ComplianceReviewAnswer.safeParse({ summary: "s", findings: [], regimesRun: ["pci"] }).success).toBe(false);
  });
});

describe("the compliance_review pack", () => {
  const helpers = ["soc2-reviewer", "hipaa-reviewer", "gdpr-reviewer", "lgpd-reviewer", "us-privacy-reviewer"];

  it("is the compliance lead: read-only, reading the diff, with one Claude subagent per regime on sonnet", () => {
    const pack = PACKS.compliance_review;
    expect(pack).toMatchObject({ id: "compliance_review", kind: "agent", agent: "compliance-lead", writable: false, effort: "medium", maxTurns: 40, template: "compliance_review.md" });
    expect(pack.engines).toEqual({ default: "claude:sonnet", allowed: ["claude:sonnet", "claude:opus"] });
    expect(pack.kind === "agent" && pack.access).toMatchObject({ read: true, agent: true, write: false });
    expect(pack.kind === "agent" && pack.access.commands).toEqual(expect.arrayContaining(["git diff", "git log", "git merge-base"]));
    expect(pack.kind === "agent" && pack.access.commands).toEqual(PACKS.reviewing.kind === "agent" ? PACKS.reviewing.access.commands : []);
    expect(helpersOn(PACKS.compliance_review, "claude")).toEqual(helpers.map((role) => ({ role, engine: "claude:sonnet" })));
    expect(ComplianceRegime.options).toHaveLength(helpers.length);
  });

  it("is never the helper of another pack: a helper cannot have helpers", () => {
    for (const pack of AGENT_PACKS) expect(pack.helpers.map((h) => h.role)).not.toContain("compliance-lead");
    const run = helperPack(PACKS.compliance_review, { role: "gdpr-reviewer", engine: "claude:sonnet" });
    expect(run).toMatchObject({ agent: "gdpr-reviewer", helpers: [], engines: { default: "claude:sonnet" } });
  });
});
