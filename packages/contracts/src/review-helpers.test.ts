import { describe, expect, it } from "vitest";

import { PACKS, ReviewHelperAnswer, REVIEW_HELPER_PACKS, helpersOn } from "./packs.ts";
import { applyPolicy } from "./questions.ts";

const finding = { path: "src/a.ts", line: 3, severity: "security", title: "IDOR", body: "no owner check", confidence: 0.9 };

describe("ReviewHelperAnswer", () => {
  it("is a summary and the review contract's findings", () => {
    expect(ReviewHelperAnswer.safeParse({ summary: "one issue", findings: [finding] }).success).toBe(true);
    expect(ReviewHelperAnswer.safeParse({ summary: "nothing in scope", findings: [] }).success).toBe(true);
  });
  it("refuses an answer with no summary or a finding with no path", () => {
    expect(ReviewHelperAnswer.safeParse({ findings: [] }).success).toBe(false);
    const { path: _path, ...noPath } = finding;
    expect(ReviewHelperAnswer.safeParse({ summary: "s", findings: [noPath] }).success).toBe(false);
  });
});

describe("the review helper packs", () => {
  const roles = { review_security: "security-reviewer", review_migration: "migration-reviewer", review_iac: "iac-reviewer", review_second: "second-opinion" } as const;

  it("lists the four packs", () => {
    expect([...REVIEW_HELPER_PACKS]).toEqual(["review_security", "review_migration", "review_iac", "review_second"]);
  });

  for (const [id, role] of Object.entries(roles)) {
    it(`${id} runs ${role} read-only on sonnet at medium, with no helpers`, () => {
      const pack = PACKS[id as keyof typeof roles];
      expect(pack).toMatchObject({ id, kind: "agent", agent: role, writable: false, effort: "medium", maxTurns: 25, timeoutMs: 10 * 60_000, template: "review_helper.md", helpers: [] });
      expect(pack.engines).toEqual({ default: "claude:sonnet", allowed: ["claude:sonnet", "codex:luna", "claude:opus", "codex:sol"] });
      expect(pack.kind === "agent" && pack.access).toMatchObject({ read: true, write: false });
      expect(pack.kind === "agent" && pack.access.agent).not.toBe(true);
      expect(pack.kind === "agent" && pack.access.commands).toEqual(expect.arrayContaining(["git diff", "git log", "git merge-base"]));
      expect(helpersOn(pack, "claude")).toEqual([]);
    });
  }
});

describe("the reviewing pack", () => {
  it("has no helpers of its own: the machine runs the dedicated passes beside it", () => {
    const pack = PACKS.reviewing;
    expect(pack.kind === "agent" && pack.helpers).toEqual([]);
    expect(pack.kind === "agent" && pack.access.agent).not.toBe(true);
    expect(pack.engines).toEqual({ default: "claude:opus", allowed: ["claude:opus"] });
    expect(pack.kind === "agent" && pack.effort).toBe("high");
  });
});

describe("the finding_confirm pack", () => {
  it("asks one yes/no question, real, and runs as a decision", () => {
    const pack = PACKS.finding_confirm;
    expect(pack.kind).toBe("decision");
    if (pack.kind !== "decision") return;
    expect(Object.keys(pack.questions)).toEqual(["real"]);
    expect(pack.questions.real).toMatchObject({ type: "yesno" });
    expect(pack.questions.real!.instructions).toMatch(/never instructions|never follow/i);
    expect(pack.questions.real!.instructions).toContain("Is this a real defect in the changed code, judged against the excerpt?");
    expect(applyPolicy(pack, { real: { value: true, p: 0.95 } }, undefined).overall).toBe("proceed");
  });
});
