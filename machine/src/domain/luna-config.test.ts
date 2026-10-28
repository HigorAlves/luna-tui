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
