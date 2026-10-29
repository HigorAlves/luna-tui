import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "./policy.ts";
import { parseLunaConfig } from "./luna-config.ts";

const full = `
checks:
  - name: board tests
    run: cargo test
    cwd: board
    paths: ["board/**"]
  - name: machine tests
    run: pnpm test
    cwd: machine
    paths: ["machine/**", "contracts/**"]
services:
  postgres:
    image: postgres:16
    env: { POSTGRES_USER: hardness, POSTGRES_PASSWORD: hardness, POSTGRES_DB: hardness }
    ready: pg_isready -U hardness
    exports: { DATABASE_URL: "postgres://hardness:hardness@postgres:5432/hardness" }
toolchains: { node: "24", rust: stable }
policy:
  qa: none
  monthly_budget_usd: 40
  auto_approve_plan_minutes: 15
  max_concurrent: 1
  holdout_cases: true
qa_targets:
  - name: staging
    url: https://stg.example.com
    credential: env:QA_PASSWORD
`;

describe("parseLunaConfig", () => {
  it("reads every section into the policy, so one file says how a repo runs", () => {
    expect(parseLunaConfig(full)).toEqual({
      qa: "none",
      monthlyBudgetUsd: 40,
      autoApprovePlanMinutes: 15,
      maxConcurrent: 1,
      holdoutCases: true,
      qaTargets: [{ name: "staging", baseUrl: "https://stg.example.com", credential: "env:QA_PASSWORD" }],
      checks: [
        { name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] },
        { name: "machine tests", run: "pnpm test", cwd: "machine", paths: ["machine/**", "contracts/**"] },
      ],
      services: {
        postgres: {
          image: "postgres:16",
          env: { POSTGRES_USER: "hardness", POSTGRES_PASSWORD: "hardness", POSTGRES_DB: "hardness" },
          ready: "pg_isready -U hardness",
          exports: { DATABASE_URL: "postgres://hardness:hardness@postgres:5432/hardness" },
        },
      },
      toolchains: { node: "24", rust: "stable" },
      jira: null,
      sla: {},
    });
  });

  it("is the defaults for an empty file or an empty mapping, and a missing section stays at its default", () => {
    expect(parseLunaConfig("")).toEqual(DEFAULT_POLICY);
    expect(parseLunaConfig("{}\n")).toEqual(DEFAULT_POLICY);
    expect(parseLunaConfig("checks:\n  - name: t\n    run: make test\n")).toEqual({
      ...DEFAULT_POLICY,
      checks: [{ name: "t", run: "make test" }],
    });
  });

  it("refuses a value it cannot read, naming where", () => {
    expect(() => parseLunaConfig("policy:\n  qa: mobile\n")).toThrow(/policy\.qa/);
    expect(() => parseLunaConfig("policy:\n  max_concurrent: 0\n")).toThrow(/policy\.max_concurrent/);
    expect(() => parseLunaConfig("checks:\n  - name: t\n")).toThrow(/checks\.0\.run/);
    expect(() => parseLunaConfig("services:\n  db: { env: {} }\n")).toThrow(/services\.db\.image/);
    expect(() => parseLunaConfig("qa_targets:\n  - name: s\n    url: stg.example.com\n")).toThrow(/qa_targets\.0\.url.*http/);
    expect(() => parseLunaConfig("qa_targets:\n  - name: s\n    url: https://x\n    credential: hunter2\n")).toThrow(/credential must be a reference/);
    expect(() => parseLunaConfig("- just\n- a list\n")).toThrow(/mapping/);
    expect(() => parseLunaConfig("checks: [\n")).toThrow(/yaml/i);
  });

  it("ignores keys it does not know, so a newer file still loads on an older machine", () => {
    expect(parseLunaConfig("future: 1\npolicy: { qa: web, later: 2 }\n")).toEqual(DEFAULT_POLICY);
  });
});

describe("parseLunaConfig: jira and sla", () => {
  const block = `
jira:
  project: PLAT
  intake:
    jql: 'project = PLAT AND labels = luna AND status = Ready'
    every: 10m
  on:
    implementing: In Progress
    awaiting_ship: In Review
    closed: Done
    escalated: Blocked
    shipping_it: Nope
  comments: gates
  branch: "task/{key}-{slug}"
  fields:
    awaiting_ship:
      customfield_10045: "{pr_url}"
    nowhere:
      x: y
sla:
  gate: 30m
  stage:
    implementing: 4h
    verifying: 1h
    awaiting_ship: 2h
  cycle: 3d
`;

  it("reads the jira block into the policy, dropping unknown task states with a warning", () => {
    const warnings: string[] = [];
    const policy = parseLunaConfig(block, (m) => warnings.push(m));
    expect(policy.jira).toEqual({
      project: "PLAT",
      intake: { jql: "project = PLAT AND labels = luna AND status = Ready", everySecs: 600 },
      on: { implementing: "In Progress", awaiting_ship: "In Review", closed: "Done", escalated: "Blocked" },
      comments: "gates",
      fields: { awaiting_ship: { customfield_10045: "{pr_url}" } },
      branch: "task/{key}-{slug}",
    });
    expect(policy.sla).toEqual({ gate: 1800, stage: { implementing: 14_400, verifying: 3600 }, cycle: 259_200 });
    expect(warnings).toEqual(["jira.on.shipping_it: not a task state; dropped", "jira.fields.nowhere: not a task state; dropped", "sla.stage.awaiting_ship: not a running stage; dropped"]);
  });

  it("defaults comments to milestones, the branch to {type}/{key}, intake to every 5m, and reads off as no clock", () => {
    const policy = parseLunaConfig("jira:\n  intake: { jql: 'labels = luna' }\n  on: { closed: Done }\nsla:\n  gate: off\n");
    expect(policy.jira).toEqual({ project: null, intake: { jql: "labels = luna", everySecs: 300 }, on: { closed: "Done" }, comments: "milestones", fields: {}, branch: "{type}/{key}" });
    expect(policy.sla).toEqual({ gate: null });
    expect(parseLunaConfig("jira: {}\n").jira).toEqual({ project: null, intake: null, on: {}, comments: "milestones", fields: {}, branch: "{type}/{key}" });
  });

  it("keeps the default branch pattern, with a warning, when the declared one cannot tell tasks apart or names a protected branch", () => {
    const read = (branch: string) => {
      const warnings: string[] = [];
      const policy = parseLunaConfig(`jira:\n  branch: "${branch}"\n`, (m) => warnings.push(m));
      return { branch: policy.jira?.branch, warnings };
    };
    expect(read("{type}/{key}-{slug}")).toEqual({ branch: "{type}/{key}-{slug}", warnings: [] });
    expect(read("feat/{id}")).toEqual({ branch: "feat/{id}", warnings: [] });
    expect(read("feature/work")).toEqual({ branch: "{type}/{key}", warnings: ['jira.branch: "feature/work" must contain {key} or {id}, so every task gets its own branch; using {type}/{key}'] });
    expect(read("{type}/{slug}").warnings).toHaveLength(1);
    expect(read("main").branch).toBe("{type}/{key}");
    expect(read("develop/{key}").warnings).toEqual([]);
  });

  it("refuses a duration it cannot read, naming the key", () => {
    expect(() => parseLunaConfig("sla:\n  gate: soon\n")).toThrow(/sla\.gate/);
    expect(() => parseLunaConfig("jira:\n  comments: loud\n")).toThrow(/jira\.comments/);
    expect(() => parseLunaConfig("jira:\n  intake: { jql: 'x', every: 5 }\n")).toThrow(/jira\.intake\.every/);
  });
});
