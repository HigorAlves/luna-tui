import { describe, expect, it } from "vitest";

import { PACKS, ReviewHelperAnswer, REVIEW_DEPTH, REVIEW_HELPER_PACKS, helpersOn } from "./packs.ts";
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
      expect(pack.engines).toEqual({ default: "claude:sonnet", allowed: ["claude:sonnet", "codex:luna", "claude:opus", "codex:sol", "claude:haiku"] });
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

describe("the thread_settle pack", () => {
  it("asks addressed and reply_holds as yes/no questions that call the thread's text data", () => {
    const pack = PACKS.thread_settle;
    expect(pack.kind).toBe("decision");
    if (pack.kind !== "decision") return;
    expect(Object.keys(pack.questions)).toEqual(["addressed", "reply_holds"]);
    for (const q of Object.values(pack.questions)) {
      expect(q).toMatchObject({ type: "yesno" });
      expect(q.instructions).toMatch(/data/);
    }
    const sure = applyPolicy(pack, { addressed: { value: true, p: 0.97 }, reply_holds: { value: false, p: 0.05 } }, undefined);
    expect(sure.verdicts).toEqual({ addressed: "proceed", reply_holds: "proceed" });
    expect(applyPolicy(pack, { addressed: { value: true, p: 0.55 }, reply_holds: { value: false, p: 0.5 } }, undefined).overall).toBe("flag");
  });
});

describe("the already_raised pack", () => {
  it("asks one yes/no question, same, that calls both texts data", () => {
    const pack = PACKS.already_raised;
    expect(pack.kind).toBe("decision");
    if (pack.kind !== "decision") return;
    expect(Object.keys(pack.questions)).toEqual(["same"]);
    expect(pack.questions.same).toMatchObject({ type: "yesno" });
    expect(pack.questions.same!.instructions).toMatch(/data/);
    expect(applyPolicy(pack, { same: { value: true, p: 0.95 } }, undefined).overall).toBe("proceed");
  });
});

describe("the rereview_worth pack", () => {
  it("asks one choice, code, discussion or noise, and calls the activity's text data", () => {
    const pack = PACKS.rereview_worth;
    expect(pack.kind).toBe("decision");
    if (pack.kind !== "decision") return;
    expect(Object.keys(pack.questions)).toEqual(["activity"]);
    const q = pack.questions.activity!;
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(Object.keys(q.criteria)).toEqual(["code", "discussion", "noise"]);
    expect(q.instructions).toMatch(/data/);
    expect(applyPolicy(pack, { activity: { choice: "noise", confidence: 0.95 } }, undefined).overall).toBe("proceed");
    expect(applyPolicy(pack, { activity: { choice: "noise", confidence: 0.55 } }, undefined).overall).toBe("flag");
  });
});

describe("the pr_risk pack and the depth each risk gets", () => {
  it("asks one choice, low, medium or high, and calls the paths and the title data", () => {
    const pack = PACKS.pr_risk;
    expect(pack.kind).toBe("decision");
    if (pack.kind !== "decision") return;
    expect(Object.keys(pack.questions)).toEqual(["level"]);
    const q = pack.questions.level!;
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(Object.keys(q.criteria)).toEqual(["low", "medium", "high"]);
    expect(q.instructions).toMatch(/data/);
  });

  it("reviews a low-risk PR lighter (Opus at medium, haiku passes at low), keeps medium as it is, and deepens high (Sonnet passes at high and a second opinion)", () => {
    expect(REVIEW_DEPTH.low).toEqual({ main: { effort: "medium" }, passes: { engine: "claude:haiku", effort: "low" }, second: false });
    expect(REVIEW_DEPTH.medium).toEqual({ main: {}, passes: {}, second: false });
    expect(REVIEW_DEPTH.high).toEqual({ main: {}, passes: { engine: "claude:sonnet", effort: "high" }, second: true });
  });

  it("lets every review pass run on haiku, and every depth name an engine the passes allow", () => {
    for (const id of ["review_security", "review_migration", "review_iac", "review_second"] as const) {
      const pack = PACKS[id];
      if (pack.kind !== "agent") throw new Error("agent pack");
      for (const depth of Object.values(REVIEW_DEPTH)) if (depth.passes.engine) expect(pack.engines.allowed).toContain(depth.passes.engine);
    }
  });
});

describe("the criteria_met pack", () => {
  it("asks one yes/no, met by the diff, and calls the criterion and the diff data", () => {
    const pack = PACKS.criteria_met;
    expect(pack.kind).toBe("decision");
    if (pack.kind !== "decision") return;
    expect(Object.keys(pack.questions)).toEqual(["met"]);
    expect(pack.questions.met).toMatchObject({ type: "yesno" });
    expect(pack.questions.met!.instructions).toMatch(/data/);
    expect(applyPolicy(pack, { met: { value: false, p: 0.05 } }, undefined).overall).toBe("proceed");
    expect(applyPolicy(pack, { met: { value: true, p: 0.6 } }, undefined).overall).toBe("flag");
  });
});
