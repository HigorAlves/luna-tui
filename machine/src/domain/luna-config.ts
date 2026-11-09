// A repo's `luna.yaml`: everything the machine needs to run that repo, in one file. Pure:
// parsing and validation only; the store (application/policy.ts) reads it from disk.
import { FACTORY_DEFAULTS, type JiraConfig, LunaConfig, RUNNING, type SlaConfig, TaskState, factoryConfigOf, hostPatternProblem, normalizeHostPattern } from "@hardness/contracts";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { stagesProblem } from "./engine-choice.ts";
import { branchPatternProblem } from "./jira-link.ts";
import { DEFAULT_JIRA_BRANCH, DEFAULT_JIRA_COMMENTS, DEFAULT_POLICY, type JiraPolicy, type Policy, PolicyParseError } from "./policy.ts";
import { type SlaTargets, parseDuration } from "./sla.ts";

/** Said about a key the machine drops rather than refuse the whole file; the store says it once per version. */
export type Warn = (message: string) => void;
const quiet: Warn = () => {};

export const CONFIG_FILE = "luna.yaml";
export { LunaConfig };

/** The config as data, validated; a bad value throws naming its path, as does an engine its pack does not allow. */
export function validateLunaConfig(raw: unknown, warn: Warn = quiet): LunaConfig {
  const parsed = LunaConfig.safeParse(legacyEgress(raw, warn));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new PolicyParseError(`${issue.path.join(".") || "file"}: ${issue.message}`);
  }
  // `luna-app` is the machine's own alias for the app it starts for the browser run.
  if (parsed.data.services && "luna-app" in parsed.data.services) throw new PolicyParseError("services.luna-app: luna-app is the name the machine gives the app it starts; call the service something else");
  if (parsed.data.checks?.some((check) => check.name === "luna-app")) throw new PolicyParseError("checks: a check may not be named luna-app (the machine's name for the app it starts)");
  const engines = stagesProblem(parsed.data.engines ?? {});
  if (engines) throw new PolicyParseError(`engines.${engines}`);
  return parsed.data;
}

/** Before this wave `sandbox.egress` was a list nothing read (`[registries, github]`); it is a section now. The two preset
 *  words are dropped, any other entry that is a valid host pattern becomes an `allow` entry, and the file is told once. */
function legacyEgress(raw: unknown, warn: Warn): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const sandbox = (raw as Record<string, unknown>).sandbox;
  if (sandbox === null || typeof sandbox !== "object" || Array.isArray(sandbox)) return raw;
  const egress = (sandbox as Record<string, unknown>).egress;
  if (!Array.isArray(egress)) return raw;
  const allow = egress
    .filter((entry): entry is string => typeof entry === "string")
    .map(normalizeHostPattern)
    .filter((entry) => entry !== "registries" && entry !== "github" && hostPatternProblem(entry) === null);
  warn("sandbox.egress is now a section (allow, registries); the old list was read as: " + (allow.length ? `allow ${allow.join(", ")}` : "no extra hosts"));
  return { ...(raw as object), sandbox: { ...(sandbox as object), egress: { allow: [...new Set(allow)] } } };
}

/** The file text for a config, sections in the order people read them, empty ones left out. */
export function renderLunaConfig(config: LunaConfig): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ["checks", "services", "toolchains", "policy", "qa_targets", "jira", "sla", "engines", "budget", "evidence", "freeze", "dedup", "backlog", "tickets", "conversation", "triage", "scoring", "fast_lane", "plan", "size", "build", "sandbox", "verify", "ship"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value as object).length === 0) continue;
    ordered[key] = value;
  }
  const header = "# luna.yaml: how Luna runs this repo. docs/configuration.md explains every key.\n";
  return header + (Object.keys(ordered).length === 0 ? "{}\n" : toYaml(ordered, { lineWidth: 0 }));
}

/** The policy a luna.yaml declares; an empty file is the defaults, a bad value throws naming its path. */
export function parseLunaConfig(text: string, warn: Warn = quiet): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PolicyParseError(`not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || raw === undefined) return { ...DEFAULT_POLICY, qaTargets: [], services: {}, toolchains: {}, sla: {}, engines: {}, engineBudgets: {}, decisions: {}, freeze: [], factory: structuredClone(FACTORY_DEFAULTS) };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PolicyParseError("the file must be a YAML mapping");
  return policyOf(validateLunaConfig(raw, warn), warn);
}

/** What a check of a file's text found: every schema problem (not only the first), what the machine would drop with a warning, and the
 *  keys it does not know. The schema strips an unknown key, so a misspelt one would otherwise change nothing without a word. */
export interface ConfigCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
  unknownKeys: string[];
}

const MAX_REPORTED = 50;

/** Checks a luna.yaml's text as the machine will read it, for the setup skill and the board: pure, nothing is written. */
export function checkLunaConfigText(text: string): ConfigCheck {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ok: false, problems: [`not valid YAML: ${error instanceof Error ? error.message : String(error)}`], warnings, unknownKeys: [] };
  }
  if (raw === null || raw === undefined) return { ok: true, problems: [], warnings, unknownKeys: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["the file must be a YAML mapping"], warnings, unknownKeys: [] };
  const parsed = LunaConfig.safeParse(legacyEgress(raw, (m) => warnings.push(m)));
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, MAX_REPORTED).map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`);
    return { ok: false, problems, warnings, unknownKeys: unknownKeysOf(raw, null) };
  }
  const unknownKeys = unknownKeysOf(raw, parsed.data);
  try {
    // The rules past the schema (luna-app, engines, durations, jira patterns), with the warnings the store would say.
    parseLunaConfig(text, (m) => warnings.push(m));
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)], warnings, unknownKeys };
  }
  return { ok: true, problems: [], warnings: [...new Set(warnings)], unknownKeys };
}

/** The dotted paths of keys in `raw` the parsed config dropped. With no parsed config (the schema refused it), only unknown top-level keys. */
function unknownKeysOf(raw: unknown, parsed: unknown): string[] {
  const out: string[] = [];
  const top = new Set(Object.keys(LunaConfig.shape));
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= MAX_REPORTED || a === null || typeof a !== "object" || b === null || typeof b !== "object") return;
    if (Array.isArray(a) || Array.isArray(b)) {
      // A list item (a check, a freeze window) is compared with the parsed item at its place.
      if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) a.forEach((item, i) => walk(item, b[i], `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(a)) {
      const at = path ? `${path}.${key}` : key;
      if (!(key in (b as object))) out.push(at);
      else walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], at);
    }
  };
  if (parsed === null) {
    for (const key of Object.keys(raw as object)) if (!top.has(key)) out.push(key);
    return out;
  }
  walk(raw, parsed, "");
  // A record (services, engines, decisions…) keeps every key it was given, so only fixed shapes report here.
  return out;
}

/** The `conversation` block as policy: a file opts in channels only (`C…`, and `G…` for a private one). A DM or group DM id is dropped with a warning: a repository's file never makes the machine read a DM. */
function conversationOf(conversation: LunaConfig["conversation"], warn: Warn): LunaConfig["conversation"] {
  if (!conversation?.channels) return conversation;
  const channels = conversation.channels.filter((id) => {
    if (!id.startsWith("D")) return true;
    warn(`conversation.channels: ${id} is a direct message; dropped (a DM is opted in from the board)`);
    return false;
  });
  return { ...conversation, channels };
}

const DEFAULT_INTAKE_EVERY_SECS = 300;

const isState = (key: string): boolean => TaskState.safeParse(key).success;

/** A duration key of the file, as seconds; a bad value throws naming the key. */
function seconds(path: string, value: string): number | null {
  try {
    return parseDuration(value, path);
  } catch (error) {
    throw new PolicyParseError(error instanceof Error ? error.message : String(error));
  }
}

/** The `jira` block as policy: unknown task states in `on` and `fields` are dropped with a warning, as
 *  is a `branch` pattern that cannot tell tasks apart (no `{key}` or `{id}`) or spells a protected branch. */
export function jiraPolicyOf(jira: JiraConfig, warn: Warn = quiet): JiraPolicy {
  const on: JiraPolicy["on"] = {};
  for (const [state, status] of Object.entries(jira.on ?? {})) {
    if (isState(state)) on[state] = status;
    else warn(`jira.on.${state}: not a task state; dropped`);
  }
  const fields: JiraPolicy["fields"] = {};
  for (const [state, values] of Object.entries(jira.fields ?? {})) {
    if (isState(state)) fields[state] = values;
    else warn(`jira.fields.${state}: not a task state; dropped`);
  }
  const every = jira.intake?.every === undefined ? DEFAULT_INTAKE_EVERY_SECS : seconds("jira.intake.every", jira.intake.every);
  let branch = jira.branch ?? DEFAULT_JIRA_BRANCH;
  const problem = branchPatternProblem(branch);
  if (problem) {
    warn(`jira.branch: ${problem}; using ${DEFAULT_JIRA_BRANCH}`);
    branch = DEFAULT_JIRA_BRANCH;
  }
  return {
    project: jira.project ?? null,
    intake: jira.intake ? { jql: jira.intake.jql, everySecs: every ?? DEFAULT_INTAKE_EVERY_SECS } : null,
    on,
    comments: jira.comments ?? DEFAULT_JIRA_COMMENTS,
    fields,
    branch,
  };
}

/** The `sla` block as targets in seconds; a stage that does not run is dropped with a warning. */
export function slaTargetsOf(sla: SlaConfig, warn: Warn = quiet): Partial<SlaTargets> {
  const targets: Partial<SlaTargets> = {};
  if (sla.gate !== undefined) targets.gate = seconds("sla.gate", sla.gate);
  if (sla.cycle !== undefined) targets.cycle = seconds("sla.cycle", sla.cycle);
  if (sla.archive !== undefined) targets.archive = seconds("sla.archive", sla.archive);
  if (sla.stage) {
    const stage: Record<string, number> = {};
    for (const [name, value] of Object.entries(sla.stage)) {
      if (!RUNNING.has(name as TaskState)) {
        warn(`sla.stage.${name}: not a running stage; dropped`);
        continue;
      }
      const secs = seconds(`sla.stage.${name}`, value);
      if (secs !== null) stage[name] = secs;
    }
    targets.stage = stage;
  }
  return targets;
}

/** The `ship` block, with the old `policy.auto_merge` read as `ship.auto_merge` when the new key is absent (one warning per parse of the file). */
function shipOf(config: LunaConfig, warn: Warn): LunaConfig["ship"] {
  const legacy = config.policy?.auto_merge;
  if (legacy === undefined || config.ship?.auto_merge !== undefined) return config.ship;
  warn(`policy.auto_merge is the old spelling of ship.auto_merge; it is read as ship.auto_merge: ${legacy}`);
  return { ...config.ship, auto_merge: legacy };
}

/** The allow list as the proxy compares it: lowercased, no duplicates. */
function lowerAllow(factory: Policy["factory"]): Policy["factory"] {
  factory.sandbox.egress.allow = [...new Set(factory.sandbox.egress.allow.map(normalizeHostPattern))];
  return factory;
}

/** The policy a validated config means. */
export function policyOf(config: LunaConfig, warn: Warn = quiet): Policy {
  const { policy = {}, qa_targets = [], checks, services = {}, toolchains = {}, jira, sla, engines = {}, budget, evidence, freeze = [] } = config;
  return {
    qa: policy.qa ?? DEFAULT_POLICY.qa,
    monthlyBudgetUsd: policy.monthly_budget_usd ?? null,
    autoApprovePlanMinutes: policy.auto_approve_plan_minutes ?? null,
    maxConcurrent: policy.max_concurrent ?? null,
    holdoutCases: policy.holdout_cases ?? false,
    graph: policy.graph !== "off",
    qaTargets: qa_targets.map((target) => ({ name: target.name, baseUrl: target.url, credential: target.credential ?? null, reentrant: target.reentrant ?? true })),
    checks: checks ?? null,
    services,
    toolchains: Object.fromEntries(Object.entries(toolchains).map(([tool, version]) => [tool, String(version)])),
    jira: jira ? jiraPolicyOf(jira, warn) : null,
    sla: sla ? slaTargetsOf(sla, warn) : {},
    engines,
    engineBudgets: budget?.engines ?? {},
    decisions: (policy.decisions ?? {}) as Policy["decisions"],
    evidenceRetentionDays: evidence?.retention_days ?? null,
    freeze: freeze.map((f) => ({ ...f })),
    factory: lowerAllow(factoryConfigOf({ backlog: config.backlog, tickets: config.tickets, conversation: conversationOf(config.conversation, warn), dedup: config.dedup, triage: config.triage, scoring: config.scoring, graph: config.graph, fast_lane: config.fast_lane, plan: config.plan, size: config.size, build: config.build, sandbox: config.sandbox, verify: config.verify, evidence: config.evidence, learning: config.learning, ship: shipOf(config, warn) })),
  };
}
