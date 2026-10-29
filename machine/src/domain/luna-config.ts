// A repo's `luna.yaml`: everything the machine needs to run that repo, in one file. Pure:
// parsing and validation only; the store (application/policy.ts) reads it from disk.
import { type JiraConfig, LunaConfig, RUNNING, type SlaConfig, TaskState } from "@hardness/contracts";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { branchPatternProblem } from "./jira-link.ts";
import { DEFAULT_JIRA_BRANCH, DEFAULT_JIRA_COMMENTS, DEFAULT_POLICY, type JiraPolicy, type Policy, PolicyParseError } from "./policy.ts";
import { type SlaTargets, parseDuration } from "./sla.ts";

/** Said about a key the machine drops rather than refuse the whole file; the store says it once per version. */
export type Warn = (message: string) => void;
const quiet: Warn = () => {};

export const CONFIG_FILE = "luna.yaml";
export { LunaConfig };

/** The config as data, validated; a bad value throws naming its path. */
export function validateLunaConfig(raw: unknown): LunaConfig {
  const parsed = LunaConfig.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new PolicyParseError(`${issue.path.join(".") || "file"}: ${issue.message}`);
  }
  return parsed.data;
}

/** The file text for a config, sections in the order people read them, empty ones left out. */
export function renderLunaConfig(config: LunaConfig): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ["checks", "services", "toolchains", "policy", "qa_targets", "jira", "sla"] as const) {
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
  if (raw === null || raw === undefined) return { ...DEFAULT_POLICY, qaTargets: [], services: {}, toolchains: {}, sla: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PolicyParseError("the file must be a YAML mapping");
  return policyOf(validateLunaConfig(raw), warn);
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

/** The policy a validated config means. */
export function policyOf(config: LunaConfig, warn: Warn = quiet): Policy {
  const { policy = {}, qa_targets = [], checks, services = {}, toolchains = {}, jira, sla } = config;
  return {
    qa: policy.qa ?? DEFAULT_POLICY.qa,
    monthlyBudgetUsd: policy.monthly_budget_usd ?? null,
    autoApprovePlanMinutes: policy.auto_approve_plan_minutes ?? null,
    maxConcurrent: policy.max_concurrent ?? null,
    holdoutCases: policy.holdout_cases ?? false,
    qaTargets: qa_targets.map((target) => ({ name: target.name, baseUrl: target.url, credential: target.credential ?? null })),
    checks: checks ?? null,
    services,
    toolchains: Object.fromEntries(Object.entries(toolchains).map(([tool, version]) => [tool, String(version)])),
    jira: jira ? jiraPolicyOf(jira, warn) : null,
    sla: sla ? slaTargetsOf(sla, warn) : {},
  };
}
