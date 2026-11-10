import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONSUMED_FROM, FACTORY_DEFAULTS, factoryConfigOf } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, PolicyParseError } from "./policy.ts";
import { FactoryConfigInput } from "@hardness/contracts";
import { checkLunaConfigText, parseLunaConfig, policyOf, renderLunaConfig, validateLunaConfig } from "./luna-config.ts";

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
    reentrant: false
  - name: preview
    url: https://pr-1.example.com
engines:
  triage: claude:opus
budget:
  engines: { "openai:sol": 10, codex: 0 }
evidence:
  retention_days: 30
freeze:
  - from: "2026-12-24T00:00:00Z"
    to: "2026-12-27T00:00:00Z"
    reason: holiday freeze
`;

describe("conversation.channels in a luna.yaml", () => {
  it("opts in channels (C, G) only: a DM or group DM id still parses, is dropped with a warning, and is opted in from the board", () => {
    const warnings: string[] = [];
    const policy = parseLunaConfig("conversation:\n  channels: [C0123ABC, D0123ABC, G0123ABC]\n", (m) => warnings.push(m));
    expect(policy.factory.conversation.channels).toEqual(["C0123ABC", "G0123ABC"]);
    expect(warnings).toEqual([expect.stringContaining("conversation.channels")]);
    expect(warnings[0]).toContain("D0123ABC");
    expect(parseLunaConfig("conversation:\n  channels: [C0123ABC]\n").factory.conversation.channels).toEqual(["C0123ABC"]);
  });
});

describe("parseLunaConfig", () => {
  it("reads every section into the policy, so one file says how a repo runs", () => {
    expect(parseLunaConfig(full)).toEqual({
      qa: "none",
      monthlyBudgetUsd: 40,
      autoApprovePlanMinutes: 15,
      maxConcurrent: 1,
      holdoutCases: true,
      graph: true,
      // A target is re-entrant unless luna.yaml says it must not be driven twice (the video recording drives it again).
      qaTargets: [
        { name: "staging", baseUrl: "https://stg.example.com", credential: "env:QA_PASSWORD", reentrant: false },
        { name: "preview", baseUrl: "https://pr-1.example.com", credential: null, reentrant: true },
      ],
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
      engines: { triage: "claude:opus" },
      engineBudgets: { "openai:sol": 10, codex: 0 },
      decisions: {},
      evidenceRetentionDays: 30,
      freeze: [{ from: "2026-12-24T00:00:00Z", to: "2026-12-27T00:00:00Z", reason: "holiday freeze" }],
      factory: factoryConfigOf({ evidence: { retention_days: 30 } }),
    });
  });

  it("refuses a freeze window whose dates do not parse", () => {
    expect(() => parseLunaConfig('freeze:\n  - from: soon\n    to: "2026-12-27T00:00:00Z"\n    reason: r\n')).toThrow(/freeze/);
    expect(parseLunaConfig('freeze:\n  - from: "2026-12-24"\n    to: "2026-12-27T00:00:00Z"\n    reason: r\n').freeze).toHaveLength(1);
  });

  it("reads ship.auto_merge (medium_when_review_required by default); the old policy.auto_merge is read as the same word, with one warning, unless ship.auto_merge is set", () => {
    const warnings: string[] = [];
    expect(parseLunaConfig("").factory.ship.auto_merge).toBe("medium_when_review_required");
    expect(parseLunaConfig("policy:\n  auto_merge: low\n", (m) => warnings.push(m)).factory.ship.auto_merge).toBe("low");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/policy\.auto_merge.*ship\.auto_merge/);
    expect(parseLunaConfig("policy:\n  auto_merge: medium\n").factory.ship.auto_merge).toBe("medium");
    expect(parseLunaConfig("policy:\n  auto_merge: off\n").factory.ship.auto_merge).toBe("off");
    const both: string[] = [];
    expect(parseLunaConfig("policy:\n  auto_merge: low\nship:\n  auto_merge: medium\n", (m) => both.push(m)).factory.ship.auto_merge).toBe("medium");
    expect(both).toEqual([]);
    expect(() => parseLunaConfig("policy:\n  auto_merge: high\n")).toThrow(/auto_merge/);
    expect(parseLunaConfig("").freeze).toEqual([]);
  });

  it("reads evidence.retention_days: null when absent, 0 to keep nothing swept, a negative or fractional value refused", () => {
    expect(parseLunaConfig("").evidenceRetentionDays).toBeNull();
    expect(parseLunaConfig("evidence: {}\n").evidenceRetentionDays).toBeNull();
    expect(parseLunaConfig("evidence:\n  retention_days: 0\n").evidenceRetentionDays).toBe(0);
    expect(() => parseLunaConfig("evidence:\n  retention_days: -1\n")).toThrow(/evidence\.retention_days/);
    expect(() => parseLunaConfig("evidence:\n  retention_days: 1.5\n")).toThrow(/evidence\.retention_days/);
  });

  it("writes the evidence block back after budget when a config is rendered", () => {
    const text = renderLunaConfig(validateLunaConfig({ budget: { engines: { "openai:sol": 5 } }, evidence: { retention_days: 14 }, engines: { triage: "claude:opus" } }));
    expect(text.indexOf("engines:")).toBeLessThan(text.indexOf("budget:"));
    expect(text.indexOf("budget:")).toBeLessThan(text.indexOf("evidence:"));
    expect(text).toContain("retention_days: 14");
  });

  it("reads policy.graph: on by default, off when the repo says so", () => {
    expect(parseLunaConfig("").graph).toBe(true);
    expect(parseLunaConfig("policy:\n  graph: on\n").graph).toBe(true);
    expect(parseLunaConfig("policy:\n  graph: off\n").graph).toBe(false);
    expect(() => parseLunaConfig("policy:\n  graph: maybe\n")).toThrow(/policy\.graph/);
  });

  it("reads policy.decisions: per decision pack, per question, a repo's own confidence bars", () => {
    const text = "policy:\n  decisions:\n    triage_signals:\n      kind: { proceed: 0.9 }\n      area: { proceed: 0.6, flag: 0.4 }\n";
    expect(parseLunaConfig(text).decisions).toEqual({ triage_signals: { kind: { proceed: 0.9 }, area: { proceed: 0.6, flag: 0.4 } } });
    expect(() => parseLunaConfig("policy:\n  decisions:\n    triage_signals:\n      kind: { proceed: 1.5 }\n")).toThrow(/policy\.decisions/);
  });

  it("reads sla.archive in seconds, off as null, and leaves it out when the file says nothing", () => {
    expect(parseLunaConfig("sla:\n  archive: 5d\n").sla).toEqual({ archive: 432_000 });
    expect(parseLunaConfig("sla:\n  archive: off\n").sla).toEqual({ archive: null });
    expect(parseLunaConfig("sla:\n  gate: 1h\n").sla).toEqual({ gate: 3600 });
    expect(() => parseLunaConfig("sla:\n  archive: whenever\n")).toThrow(/sla\.archive/);
  });

  it("is the defaults for an empty file or an empty mapping, and a missing section stays at its default", () => {
    expect(parseLunaConfig("")).toEqual(DEFAULT_POLICY);
    expect(parseLunaConfig("{}\n")).toEqual(DEFAULT_POLICY);
    expect(parseLunaConfig("checks:\n  - name: t\n    run: make test\n")).toEqual({
      ...DEFAULT_POLICY,
      checks: [{ name: "t", run: "make test" }],
    });
  });

  it("keeps a check's coverage report path", () => {
    expect(parseLunaConfig("checks:\n  - name: t\n    run: make test\n    coverage: coverage/lcov.info\n").checks).toEqual([{ name: "t", run: "make test", coverage: "coverage/lcov.info" }]);
  });

  it("refuses a value it cannot read, naming where", () => {
    expect(() => parseLunaConfig("policy:\n  qa: mobile\n")).toThrow(/policy\.qa/);
    expect(() => parseLunaConfig("policy:\n  max_concurrent: 0\n")).toThrow(/policy\.max_concurrent/);
    expect(() => parseLunaConfig("checks:\n  - name: t\n")).toThrow(/checks\.0\.run/);
    expect(() => parseLunaConfig("services:\n  db: { env: {} }\n")).toThrow(/services\.db\.image/);
    expect(() => parseLunaConfig("qa_targets:\n  - name: s\n    url: https://x\n    reentrant: sometimes\n")).toThrow(/qa_targets\.0\.reentrant/);
    expect(() => parseLunaConfig("qa_targets:\n  - name: s\n    url: stg.example.com\n")).toThrow(/qa_targets\.0\.url.*http/);
    expect(() => parseLunaConfig("qa_targets:\n  - name: s\n    url: https://x\n    credential: hunter2\n")).toThrow(/credential must be a reference/);
    expect(() => parseLunaConfig("- just\n- a list\n")).toThrow(/mapping/);
    expect(() => parseLunaConfig("checks: [\n")).toThrow(/yaml/i);
    expect(() => parseLunaConfig("engines:\n  triage: gpt-6\n")).toThrow(/engines\.triage/);
    expect(() => parseLunaConfig("engines:\n  nope: claude:opus\n")).toThrow(/engines/);
  });

  it("refuses a monthly engine cap on Claude, on no engine, or below zero, naming the key", () => {
    expect(() => parseLunaConfig("budget:\n  engines: { \"claude:opus\": 5 }\n")).toThrow(/^budget\.engines\.claude:opus: claude:opus: no monthly cap on Claude/);
    expect(() => parseLunaConfig("budget:\n  engines: { gpt: 5 }\n")).toThrow(/^budget\.engines\.gpt: gpt: not an engine or a credential/);
    expect(() => parseLunaConfig("budget:\n  engines: { openai: -1 }\n")).toThrow(/^budget\.engines\.openai/);
  });

  it("refuses an engine its pack does not allow, like any other bad value", () => {
    expect(() => parseLunaConfig("engines:\n  triage: jev\n")).toThrow(/^engines\.triage: jev is not allowed for triage \(allowed: claude:opus, codex:sol\)$/);
    expect(() => validateLunaConfig({ engines: { implementing: "codex:sol" } })).toThrow(/engines\.implementing: codex:sol is not allowed/);
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

describe("the v2.2 diagram's sections", () => {
  it("are the diagram's defaults for a file that has none, and for an empty file", () => {
    expect(parseLunaConfig("policy:\n  qa: web\n").factory).toEqual(FACTORY_DEFAULTS);
    expect(parseLunaConfig("").factory).toEqual(FACTORY_DEFAULTS);
  });

  it("merge a repo's values over the defaults, key by key", () => {
    const policy = parseLunaConfig("plan:\n  coverage_rounds: 5\n  approvers:\n    high: 3\nship:\n  stale_days: 30\n  merge:\n    method: rebase\n");
    expect(policy.factory.plan).toMatchObject({ coverage_rounds: 5, plan_check_retries: 2, approvers: { low: 1, medium: 1, high: 3 } });
    expect(policy.factory.ship).toMatchObject({ stale_days: 30, merge: { method: "rebase", queue: true } });
  });

  it("carry the backlog's bar into the policy beside the stage chain's sections", () => {
    const policy = parseLunaConfig("backlog:\n  stale_days: 3\nsandbox:\n  egress:\n    allow: [example.com]\n");
    expect(policy.factory.backlog).toEqual({ stale_days: 3 });
    expect(policy.factory.sandbox.egress.allow).toContain("example.com");
  });

  it("name the key of a wrong type, an out-of-range number or an unknown key", () => {
    expect(() => parseLunaConfig("dedup:\n  duplicate: 2\n")).toThrow(/dedup\.duplicate/);
    expect(() => parseLunaConfig("plan:\n  coverage_rounds: many\n")).toThrow(/plan\.coverage_rounds/);
    expect(() => parseLunaConfig("build:\n  max_minutes: 0\n")).toThrow(/build\.max_minutes/);
    expect(() => parseLunaConfig("triage:\n  confidence:\n    mood: 1\n")).toThrow(/mood/);
    expect(() => parseLunaConfig("ship:\n  nope: 1\n")).toThrow(/nope/);
    expect(() => parseLunaConfig("ship:\n  nope: 1\n")).toThrow(PolicyParseError);
  });

  it("store the command and template strings as opaque text: nothing runs or renders them", () => {
    const policy = parseLunaConfig('verify:\n  mutation:\n    command: "rm -rf / ; stryker"\n  e2e:\n    deploy:\n      command: "$(curl evil)"\n    start:\n      command: "npm start"\nship:\n  merge:\n    commit_template: "{{secret}}"\n');
    expect(policy.factory.verify.mutation.command).toBe("rm -rf / ; stryker");
    expect(policy.factory.verify.e2e.deploy.command).toBe("$(curl evil)");
    expect(policy.factory.verify.e2e.start.command).toBe("npm start");
    expect(policy.factory.ship.merge.commit_template).toBe("{{secret}}");
  });

  it("leave the existing keys meaning what they did, and win over the new forms", () => {
    const policy = parseLunaConfig("policy:\n  auto_merge: low\nevidence:\n  retention_days: 7\nsla:\n  cycle: 3d\nship:\n  auto_merge: medium\n");
    expect(policy.evidenceRetentionDays).toBe(7);
    expect(policy.sla.cycle).toBe(3 * 86_400);
    // the new form wins over the old spelling
    expect(policy.factory.ship.auto_merge).toBe("medium");
    expect(parseLunaConfig("ship:\n  preview: off\n").factory.ship.auto_merge).toBe("medium_when_review_required");
  });

  it("render back into a file the parser reads to the same sections", () => {
    const config = validateLunaConfig({ plan: { coverage_rounds: 4 }, ship: { stale_days: 21 } });
    expect(parseLunaConfig(renderLunaConfig(config)).factory.plan.coverage_rounds).toBe(4);
    expect(parseLunaConfig(renderLunaConfig(config)).factory.ship.stale_days).toBe(21);
  });

  it("are read by code for every key marked wave 8, and by the values' consumers only", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = ["../application/stages/plan.ts", "../application/stages/ship-monitor.ts", "../application/stages/e2e.ts"].map((f) => readFileSync(join(here, f), "utf8")).join("\n");
    const read: Record<string, RegExp> = {
      "plan.coverage_rounds": /coverage_rounds/,
      "plan.plan_check_retries": /plan_check_retries/,
      "ship.stale_days": /factory\.ship\.stale_days/,
      "verify.env_flake_retries": /env_flake_retries/,
      "verify.ci_flaky_reruns": /factory\.verify\.ci_flaky_reruns/,
      "verify.auto_rebase": /factory\.verify\.auto_rebase/,
    };
    const wave8 = Object.entries(CONSUMED_FROM).filter(([, w]) => w === 8).map(([k]) => k);
    expect(Object.keys(read).sort()).toEqual(wave8.sort());
    for (const key of wave8) expect(sources).toMatch(read[key]!);
  });

  it("are read by code for every triage, scoring, graph and fast-lane key marked wave 9; the plan's own wave 9 keys are 9b's", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = ["triage-policy.ts", "fast-lane.ts", "../application/stages/triage-signals.ts", "../application/sla.ts", "../main.ts"].map((f) => readFileSync(join(here, f), "utf8")).join("\n");
    const read: Record<string, RegExp> = {
      "triage.confidence.kind": /config\.confidence\.kind/,
      "triage.confidence.size": /config\.confidence\.size/,
      "triage.confidence.urgency": /config\.confidence\.urgency/,
      "triage.confidence.risk": /config\.confidence\.risk/,
      "triage.confidence.archive": /config\.confidence\.archive/,
      "triage.flag_band": /config\.flag_band/,
      "triage.hint_weight": /config\.hint_weight/,
      "triage.max_questions": /caps\.max_questions/,
      "triage.max_rounds": /caps\.max_rounds/,
      "triage.sla.reminder_days": /sla\.reminder_days/,
      "triage.sla.archive_days": /sla\.archive_days/,
      "scoring.weights": /scoring\.weights/,
      "scoring.bands": /scoring\.bands/,
      "fast_lane.max_risk": /config\.max_risk/,
      "fast_lane.max_size": /config\.max_size/,
      "fast_lane.excluded_types": /config\.excluded_types/,
      "fast_lane.cross_team": /config\.cross_team/,
      "graph.stale_commits": /graph\.stale_commits/,
    };
    for (const [key, pattern] of Object.entries(read)) {
      expect(CONSUMED_FROM[key], key).toBe(9);
      expect(sources, key).toMatch(pattern);
    }
    const planned = Object.entries(CONSUMED_FROM).filter(([k, w]) => w === 9 && !(k in read)).map(([k]) => k).sort();
    expect(planned).toEqual(["plan.approvers.high", "plan.approvers.low", "plan.approvers.medium", "plan.approvers.outside_owning_team", "plan.coverage_score_min", "plan.sla.escalate_days", "plan.sla.reminder_days"]);
  });
});

describe("the sections of the v2.2 config reach the policy", () => {
  it("takes tickets and backlog from a real luna.yaml, through the path PolicyStore uses", () => {
    const policy = parseLunaConfig(["tickets:", "  auto: on", "  assignees: [ana]", "  teams: [payments]", "  debounce_seconds: 5", "  sla:", "    stale_days: 11", "backlog:", "  stale_days: 3", ""].join("\n"));
    expect(policy.factory.tickets).toMatchObject({ auto: "on", assignees: ["ana"], teams: ["payments"], debounce_seconds: 5, sla: { stale_days: 11, acknowledge_hours: 24 } });
    expect(policy.factory.backlog.stale_days).toBe(3);
  });

  it("takes the economy section from a real luna.yaml, and keeps the defaults when it is absent", () => {
    const economy = parseLunaConfig(["economy:", "  facts: free", "  guard:", "    redirects: 2", ""].join("\n")).factory.economy;
    expect(economy).toEqual({ ...FACTORY_DEFAULTS.economy, facts: "free", guard: { ...FACTORY_DEFAULTS.economy.guard, redirects: 2 } });
    expect(parseLunaConfig("").factory.economy).toEqual(FACTORY_DEFAULTS.economy);
    expect(() => parseLunaConfig(["economy:", "  loop_gaurd: off", ""].join("\n"))).toThrow(/economy/);
    expect(() => parseLunaConfig(["economy:", "  facts: maybe", ""].join("\n"))).toThrow(/economy\.facts/);
  });

  it("takes the learning section from a real luna.yaml, and keeps the defaults when it is absent", () => {
    expect(parseLunaConfig(["learning:", "  truth: false", "  traces: metadata", ""].join("\n")).factory.learning).toEqual({ records: true, context: "full", truth: false, traces: "metadata" });
    expect(parseLunaConfig("").factory.learning).toEqual({ records: true, context: "full", truth: true, traces: "host" });
  });

  it("renders a tickets section back into the file", () => {
    expect(renderLunaConfig(validateLunaConfig({ tickets: { auto: "on" } }))).toContain("tickets:");
  });

  it("takes the conversation section from a real luna.yaml, renders it, and refuses an unknown key", () => {
    const policy = parseLunaConfig(["conversation:", "  channels: [C0123ABC]", "  auto: on", "  debounce_seconds: 5", ""].join("\n"));
    expect(policy.factory.conversation).toMatchObject({ channels: ["C0123ABC"], auto: "on", debounce_seconds: 5, draft_expiry_hours: 24 });
    expect(renderLunaConfig(validateLunaConfig({ conversation: { channels: ["C0123ABC"] } }))).toContain("conversation:");
    expect(() => parseLunaConfig(["conversation:", "  sneaky: 1", ""].join("\n"))).toThrow(/sneaky|conversation/);
  });

  it("reads every section the FactoryConfig schema has: a section a later wave adds cannot be forgotten", () => {
    const read = new Set<string>();
    const spy = new Proxy({}, { get: (_t, key) => (read.add(String(key)), undefined) });
    policyOf(spy as never);
    const missed = Object.keys(FactoryConfigInput).filter((k) => !read.has(k));
    expect(missed).toEqual([]);
  });
});

describe("the evidence keys the film reads reach the policy from a repository's luna.yaml", () => {
  it("video_budget_s, regenerate, tts.voice and tts.language", () => {
    const policy = parseLunaConfig("evidence:\n  video_budget_s: 90\n  regenerate: 0\n  tts:\n    voice: bf_emma\n    language: en-GB\n");
    expect(policy.factory.evidence).toMatchObject({ video_budget_s: 90, regenerate: 0, tts: { voice: "bf_emma", language: "en-GB" } });
    expect(parseLunaConfig("").factory.evidence).toMatchObject({ video_budget_s: 240, regenerate: 1, tts: { voice: null, language: null } });
  });
});

describe("a repository's base image in luna.yaml", () => {
  it("reaches the policy's sandbox section, and is none when absent", () => {
    expect(parseLunaConfig("sandbox:\n  image:\n    base: python:3.13-slim\n").factory.sandbox.image).toEqual({ base: "python:3.13-slim" });
    expect(parseLunaConfig("").factory.sandbox.image).toEqual({ base: null });
  });
});

describe("sandbox.egress, before and after it became a section", () => {
  it("still parses the list form: the preset words are dropped, a valid host becomes an allow entry, and the warning is said once", () => {
    const warnings: string[] = [];
    const policy = parseLunaConfig("sandbox:\n  egress: [registries, github, Docs.Example.com, 1.2.3.4, '*']\n", (m) => warnings.push(m));
    expect(policy.factory.sandbox.egress).toEqual({ allow: ["docs.example.com"], registries: "always" });
    expect(warnings.filter((w) => w.includes("sandbox.egress"))).toHaveLength(1);
    expect(warnings[0]).toMatch(/section/);
  });

  it("reads the section form with no warning", () => {
    const warnings: string[] = [];
    const policy = parseLunaConfig("sandbox:\n  egress:\n    allow: [Docs.Example.com]\n    registries: install\n  install:\n    scripts: on\n", (m) => warnings.push(m));
    expect(policy.factory.sandbox).toMatchObject({ egress: { allow: ["docs.example.com"], registries: "install" }, install: { run: "on", scripts: "on" }, cpu: 2, memory_gb: 4 });
    expect(warnings).toEqual([]);
  });

  it("refuses a bad host in the section naming the entry", () => {
    expect(() => parseLunaConfig("sandbox:\n  egress:\n    allow: ['*.com']\n")).toThrow(/\*\.com/);
  });

  it("carries the e2e start, seed and deploy keys and a check's secrets into the policy", () => {
    const policy = parseLunaConfig("verify:\n  e2e:\n    start:\n      command: npm start\n      port: 5173\n      secrets: [APP_KEY]\n    seed:\n      command: npm run seed\n    deploy:\n      url_pattern: https://{branch}.example.com\nchecks:\n  - name: t\n    run: x\n    secrets: [DB_URL]\n");
    expect(policy.factory.verify.e2e.start).toMatchObject({ command: "npm start", port: 5173, ready: "/", secrets: ["APP_KEY"] });
    expect(policy.factory.verify.e2e.seed).toEqual({ command: "npm run seed", secrets: [] });
    expect(policy.factory.verify.e2e.deploy.url_pattern).toBe("https://{branch}.example.com");
    expect(policy.checks?.[0]?.secrets).toEqual(["DB_URL"]);
  });
});

describe("the name luna-app", () => {
  it("is the machine's alias for the app it starts: a service or a check may not take it", () => {
    expect(() => parseLunaConfig("services:\n  luna-app:\n    image: x\n")).toThrow(/services\.luna-app.*luna-app/);
    expect(() => parseLunaConfig("checks:\n  - name: luna-app\n    run: x\n")).toThrow(/checks.*luna-app/);
    expect(parseLunaConfig("services:\n  db:\n    image: x\nchecks:\n  - name: unit\n    run: x\n").services).toHaveProperty("db");
  });
});

describe("checkLunaConfigText: the setup skill's check of a file", () => {
  it("passes a good file and names the keys it does not know, at any depth", () => {
    const out = checkLunaConfigText(["checks:", "  - name: unit", "    run: pnpm test", "    timeout: 5", "polcy:", "  qa: web", "verify:", "  e2e:", "    start: { command: \"pnpm dev\", port: 3000 }"].join("\n"));
    expect(out.ok).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.unknownKeys).toEqual(["checks[0].timeout", "polcy"]);
  });

  it("lists every schema problem, not only the first", () => {
    const out = checkLunaConfigText(["policy:", "  qa: sometimes", "  monthly_budget_usd: -3"].join("\n"));
    expect(out.ok).toBe(false);
    expect(out.problems).toHaveLength(2);
    expect(out.problems.join("\n")).toMatch(/policy\.qa/);
    expect(out.problems.join("\n")).toMatch(/policy\.monthly_budget_usd/);
  });

  it("refuses what the machine refuses past the schema, and bad YAML, and reads an empty file as the defaults", () => {
    expect(checkLunaConfigText("services:\n  luna-app: { image: x }\n")).toMatchObject({ ok: false, problems: [expect.stringContaining("luna-app")] });
    expect(checkLunaConfigText("checks: [\n")).toMatchObject({ ok: false, problems: [expect.stringContaining("not valid YAML")] });
    expect(checkLunaConfigText("")).toEqual({ ok: true, problems: [], warnings: [], unknownKeys: [] });
  });
});
