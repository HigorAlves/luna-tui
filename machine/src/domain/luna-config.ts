// A repo's `luna.yaml`: everything the machine needs to run that repo, in one file. Pure:
// parsing and validation only; the store (application/policy.ts) reads it from disk.
import { LunaConfig } from "@hardness/contracts";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { DEFAULT_POLICY, type Policy, PolicyParseError } from "./policy.ts";

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
  for (const key of ["checks", "services", "toolchains", "policy", "qa_targets"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value as object).length === 0) continue;
    ordered[key] = value;
  }
  const header = "# luna.yaml: how Luna runs this repo. docs/configuration.md explains every key.\n";
  return header + (Object.keys(ordered).length === 0 ? "{}\n" : toYaml(ordered, { lineWidth: 0 }));
}

/** The policy a luna.yaml declares; an empty file is the defaults, a bad value throws naming its path. */
export function parseLunaConfig(text: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PolicyParseError(`not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || raw === undefined) return { ...DEFAULT_POLICY, qaTargets: [], services: {}, toolchains: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PolicyParseError("the file must be a YAML mapping");
  return policyOf(validateLunaConfig(raw));
}

/** The policy a validated config means. */
export function policyOf(config: LunaConfig): Policy {
  const { policy = {}, qa_targets = [], checks, services = {}, toolchains = {} } = config;
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
  };
}
