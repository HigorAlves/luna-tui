import { describe, expect, it } from "vitest";

import { applyAnswers, choosableEngines, flattenLunaConfig, parseAnswers } from "./luna-config-answers.ts";
import { PolicyParseError } from "./policy.ts";

const existing = `# mine: keep this comment
checks:
  - name: tests
    run: pnpm test # and this one
jira:
  project: OLD
  on:
    implementing: In Progress
    closed: Done
policy:
  qa: none
`;

describe("parseAnswers", () => {
  it("reads path=value lines, keeping = inside values and skipping blanks and comments", () => {
    expect(parseAnswers("jira.intake.jql=project = PLAT AND labels = luna\n\n# note\njira.on=\n")).toEqual([
      { path: ["jira", "intake", "jql"], value: "project = PLAT AND labels = luna" },
      { path: ["jira", "on"], value: "" },
    ]);
  });

  it("refuses a line that names no path", () => {
    expect(() => parseAnswers("=x")).toThrow(PolicyParseError);
    expect(() => parseAnswers("no-equals-sign")).toThrow(/line 1/);
  });
});

describe("applyAnswers", () => {
  it("edits an existing file in place, keeping its comments and untouched sections", () => {
    const { text } = applyAnswers(existing, parseAnswers("jira.project=PLAT\njira.on.awaiting_ship=In Review\npolicy.qa=web\n"));
    expect(text).toContain("# mine: keep this comment");
    expect(text).toContain("run: pnpm test # and this one");
    expect(text).toMatch(/project: PLAT/);
    expect(text).toMatch(/awaiting_ship: In Review/);
    expect(text).toMatch(/implementing: In Progress/);
    expect(text).toMatch(/qa: web/);
  });

  it("an empty value removes the key, so a section can be replaced whole", () => {
    const { text } = applyAnswers(existing, parseAnswers("jira.on=\njira.on.closed=Released\npolicy.qa=\n"));
    expect(text).not.toMatch(/In Progress/);
    expect(text).toMatch(/closed: Released/);
    expect(text).not.toMatch(/^policy:/m);
  });

  it("removing a key the file does not have, or one under a section it lacks, changes nothing", () => {
    const { text } = applyAnswers(existing, parseAnswers("budget.engines=\nengines.triage=\njira.intake=\nbudget.engines.codex=0\n"));
    expect(text).toContain("# mine: keep this comment");
    expect(text).toMatch(/budget:\n  engines:\n    codex: 0/);
    expect(text).not.toMatch(/^engines:/m);
  });

  it("numbers and booleans under policy and budget are numbers and booleans; everything else stays text", () => {
    const { config } = applyAnswers("", parseAnswers("policy.monthly_budget_usd=40\npolicy.holdout_cases=true\nbudget.engines.openai:sol=10\njira.project=123\nsla.gate=1h\n"));
    expect(config.policy).toEqual({ monthly_budget_usd: 40, holdout_cases: true });
    expect(config.budget).toEqual({ engines: { "openai:sol": 10 } });
    expect(config.jira?.project).toBe("123");
  });

  it("a new file starts with the header and the sections in the order people read them", () => {
    const { text } = applyAnswers(null, parseAnswers("engines.triage=codex:sol\njira.project=PLAT\npolicy.qa=web\n"));
    expect(text.startsWith("# luna.yaml: how Luna runs this repo.")).toBe(true);
    expect(text.indexOf("policy:")).toBeLessThan(text.indexOf("jira:"));
    expect(text.indexOf("jira:")).toBeLessThan(text.indexOf("engines:"));
  });

  it("refuses what the machine would refuse, naming the key", () => {
    expect(() => applyAnswers(null, parseAnswers("engines.triage=openai:sol\n"))).toThrow(/engines\.triage/);
    expect(() => applyAnswers(null, parseAnswers("policy.qa=sometimes\n"))).toThrow(/policy\.qa/);
    expect(() => applyAnswers(null, parseAnswers("budget.engines.claude=5\n"))).toThrow(PolicyParseError);
  });

  it("passes on the machine's warnings: a state jira.on cannot map is dropped, not fatal", () => {
    const { warnings } = applyAnswers(null, parseAnswers("jira.on.not_a_state=Done\njira.on.closed=Done\n"));
    expect(warnings.join("\n")).toMatch(/not_a_state/);
  });

  it("refuses an existing file that is not YAML rather than overwrite it", () => {
    expect(() => applyAnswers("checks: [\n", parseAnswers("policy.qa=web\n"))).toThrow(/not valid YAML/);
  });
});

describe("flattenLunaConfig", () => {
  it("lists every scalar as path=value, for the wizard's defaults", () => {
    expect(flattenLunaConfig(existing)).toEqual([
      "checks.0.name=tests",
      "checks.0.run=pnpm test",
      "jira.project=OLD",
      "jira.on.implementing=In Progress",
      "jira.on.closed=Done",
      "policy.qa=none",
    ]);
    expect(flattenLunaConfig(null)).toEqual([]);
  });
});

describe("choosableEngines", () => {
  it("lists the packs a task runs that allow more than one engine, default first", () => {
    const triage = choosableEngines().find((p) => p.pack === "triage");
    expect(triage?.engines[0]).toBe(triage?.default);
    expect(triage?.engines).toContain("codex:sol");
    expect(choosableEngines().every((p) => p.engines.length > 1)).toBe(true);
    expect(choosableEngines().some((p) => p.pack === "slack_triage")).toBe(false);
  });
});
