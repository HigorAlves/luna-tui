import { describe, expect, it } from "vitest";

import { CONSUMED_FROM, FACTORY_DEFAULTS, configKeys, factoryConfigOf } from "./config-v22.ts";
import { SCORING_DEFAULTS } from "./scoring.ts";
import { LunaConfig } from "./stage.ts";

describe("the diagram's config defaults", () => {
  it("are the numbers the diagram draws", () => {
    expect(FACTORY_DEFAULTS.dedup).toEqual({ duplicate: 0.9, related: 0.7, ask_below: 0.7, lookback_days: 90 });
    expect(FACTORY_DEFAULTS.triage.confidence).toEqual({ kind: 0.8, size: 0.6, urgency: 0.7, risk: 0.85, archive: 0.9 });
    expect(FACTORY_DEFAULTS.plan).toMatchObject({ coverage_score_min: 0.85, coverage_rounds: 3, plan_check_retries: 2, approvers: { low: 1, medium: 1, high: 2, outside_owning_team: true } });
    expect(FACTORY_DEFAULTS.size).toEqual({ target_loc: [1000, 2000], hard_limit_loc: 2500, max_children: 8, max_rounds: 3, depth: 2 });
    expect(FACTORY_DEFAULTS.build).toEqual({ max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90, backoff_minutes: [1, 30], regression_full_suite_minutes: 10 });
    expect(FACTORY_DEFAULTS.verify).toMatchObject({ coverage_drop_max: 0.5, mutation: { command: null, min_score: 0.6 }, build_rounds: 1, env_flake_retries: 1, ci_flaky_reruns: 1, auto_rebase: 1 });
    expect(FACTORY_DEFAULTS.evidence).toMatchObject({ video_budget_s: 240, regenerate: 1, storage: "release_asset", retention_days: 180 });
    expect(FACTORY_DEFAULTS.ship).toMatchObject({ preview: "off", auto_merge: "medium_when_review_required", merge: { method: "squash", queue: true, delete_branch: true, commit_template: null }, stale_days: 14, poll_minutes: 5 });
  });

  it("carry the scoring module's weights and bands", () => {
    expect(FACTORY_DEFAULTS.scoring.weights).toEqual(SCORING_DEFAULTS.weights);
    expect(FACTORY_DEFAULTS.scoring.bands).toEqual(SCORING_DEFAULTS.bands);
  });

  it("name, for every key, the wave that reads it", () => {
    const keys = configKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((k) => CONSUMED_FROM[k] === undefined)).toEqual([]);
    expect(Object.keys(CONSUMED_FROM).filter((k) => !keys.includes(k))).toEqual([]);
    expect(new Set(Object.values(CONSUMED_FROM))).toEqual(new Set([8, 9, 10, 11, 12, 13, 14, 15]));
  });

  it("mark exactly the keys whose default already equals today's constant as wave 8", () => {
    expect(Object.entries(CONSUMED_FROM).filter(([, w]) => w === 8).map(([k]) => k).sort()).toEqual(
      ["plan.coverage_rounds", "plan.plan_check_retries", "ship.stale_days", "verify.auto_rebase", "verify.ci_flaky_reruns", "verify.env_flake_retries"].sort(),
    );
  });
});

describe("the sandbox's size and keep", () => {
  it("defaults to two CPUs, four gigabytes and a day, all read from wave 11, a repository's section winning", () => {
    expect(FACTORY_DEFAULTS.sandbox).toMatchObject({ cpu: 2, memory_gb: 4, keep_hours: 24 });
    for (const key of ["sandbox.cpu", "sandbox.memory_gb", "sandbox.keep_hours"]) expect(CONSUMED_FROM[key], key).toBe(11);
    expect(factoryConfigOf({ sandbox: { cpu: 6, keep_hours: 1 } }).sandbox).toMatchObject({ cpu: 6, memory_gb: 4, keep_hours: 1 });
  });
});

describe("factoryConfigOf", () => {
  it("is the defaults for no sections, and merges a section key by key", () => {
    expect(factoryConfigOf({})).toEqual(FACTORY_DEFAULTS);
    const merged = factoryConfigOf({ plan: { coverage_rounds: 5, approvers: { high: 3 } }, ship: { merge: { method: "rebase" } } });
    expect(merged.plan).toMatchObject({ coverage_rounds: 5, plan_check_retries: 2, approvers: { low: 1, medium: 1, high: 3, outside_owning_team: true } });
    expect(merged.ship.merge).toEqual({ method: "rebase", queue: true, delete_branch: true, commit_template: null });
  });

  it("never changes the shared defaults", () => {
    const merged = factoryConfigOf({ build: { backoff_minutes: [2, 3] } });
    merged.sandbox.egress.push("x");
    expect(FACTORY_DEFAULTS.sandbox.egress).toEqual(["registries", "github"]);
    expect(FACTORY_DEFAULTS.build.backoff_minutes).toEqual([1, 30]);
  });
});

describe("the sections in a luna.yaml", () => {
  const bad = (raw: unknown) => LunaConfig.safeParse(raw);
  it("take a repo's values", () => {
    const ok = bad({ triage: { confidence: { kind: 0.5 }, max_questions: 2 }, verify: { mutation: { command: "stryker run", min_score: 0.7 }, e2e: { deploy: { command: "make deploy" } } }, ship: { merge: { commit_template: "{{title}}" } } });
    expect(ok.success).toBe(true);
  });

  it("take the graph's staleness bar and refuse a negative one", () => {
    expect(FACTORY_DEFAULTS.graph.stale_commits).toBe(50);
    expect(bad({ graph: { stale_commits: 10 } }).success).toBe(true);
    expect(bad({ graph: { stale_commits: -1 } }).success).toBe(false);
    expect(bad({ graph: { stale: 3 } }).success).toBe(false);
  });

  it("refuse a confidence outside 0..1, a negative count, a minute that is not above zero and a count with no sane bound", () => {
    expect(bad({ dedup: { duplicate: 1.5 } }).success).toBe(false);
    expect(bad({ triage: { confidence: { risk: -0.1 } } }).success).toBe(false);
    expect(bad({ plan: { coverage_rounds: -1 } }).success).toBe(false);
    expect(bad({ plan: { coverage_rounds: 1_000_000 } }).success).toBe(false);
    expect(bad({ plan: { coverage_rounds: 1.5 } }).success).toBe(false);
    expect(bad({ build: { max_minutes: 0 } }).success).toBe(false);
    expect(bad({ ship: { poll_minutes: -5 } }).success).toBe(false);
    expect(bad({ build: { backoff_minutes: [1] } }).success).toBe(false);
    expect(bad({ ship: { stale_days: "14" } }).success).toBe(false);
  });

  it("cap the loop counts, the stale days and the not-yet-wired limits", () => {
    expect(bad({ plan: { coverage_rounds: 6 } }).success).toBe(false);
    expect(bad({ plan: { plan_check_retries: 6 } }).success).toBe(false);
    expect(bad({ plan: { coverage_rounds: 5, plan_check_retries: 5 } }).success).toBe(true);
    expect(bad({ ship: { stale_days: 0 } }).success).toBe(false);
    expect(bad({ ship: { stale_days: 61 } }).success).toBe(false);
    expect(bad({ ship: { stale_days: 60 } }).success).toBe(true);
    expect(bad({ build: { max_iterations: 51 } }).success).toBe(false);
    expect(bad({ build: { max_tokens: 20_000_001 } }).success).toBe(false);
    expect(bad({ size: { hard_limit_loc: 20_001 } }).success).toBe(false);
    expect(bad({ size: { max_children: 21 } }).success).toBe(false);
    expect(bad({ size: { depth: 4 } }).success).toBe(false);
    for (const sla of ["triage", "plan", "ship"] as const) expect(bad({ [sla]: { sla: { reminder_days: 366 } } }).success).toBe(false);
    expect(bad({ ship: { sla: { escalate_days: 365 } } }).success).toBe(true);
  });

  it("refuse an unknown key inside a new section, naming it", () => {
    const r = bad({ triage: { confidence: { kind: 0.5, mood: 1 } } });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("mood");
    expect(bad({ ship: { merge: { methd: "squash" } } }).success).toBe(false);
  });

  it("still accept what an older file has: the top-level sla, evidence.retention_days, policy.auto_merge, and an unknown key in evidence", () => {
    expect(bad({ sla: { cycle: "3d" }, evidence: { retention_days: 0, somethingNew: true }, policy: { auto_merge: "low" } }).success).toBe(true);
  });
});

describe("build.backoff_minutes", () => {
  it("must start at one minute or more: a zero low bound could spin a rate-limited card", () => {
    expect(LunaConfig.safeParse({ build: { backoff_minutes: [0, 30] } }).success).toBe(false);
    expect(LunaConfig.safeParse({ build: { backoff_minutes: [0.5, 30] } }).success).toBe(false);
    expect(LunaConfig.safeParse({ build: { backoff_minutes: [1, 30] } }).success).toBe(true);
  });
});
