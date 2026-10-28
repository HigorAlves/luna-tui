// A repo's `luna.yaml`: everything the machine needs to run that repo, in one file. Pure:
// parsing and validation only; the store (application/policy.ts) reads it from disk.
import { CheckSpec, ServiceSpec } from "@hardness/contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { DEFAULT_POLICY, type Policy, PolicyParseError } from "./policy.ts";

export const CONFIG_FILE = "luna.yaml";

const positiveInt = z.number().int().positive();
const positiveUsd = z.number().positive();
const credentialRef = z
  .string()
  .regex(/^env:[A-Z_][A-Z0-9_]*$/, "credential must be a reference like env:QA_PASSWORD, never a value");

/** The file's shape. Unknown keys are ignored, so a newer file loads on an older machine. */
export const LunaConfig = z.object({
  policy: z
    .object({
      qa: z.enum(["web", "none"]).optional(),
      monthly_budget_usd: positiveUsd.optional(),
      auto_approve_plan_minutes: positiveInt.optional(),
      max_concurrent: positiveInt.optional(),
      holdout_cases: z.boolean().optional(),
    })
    .optional(),
  qa_targets: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().regex(/^https?:\/\//, "url must start with http:// or https://"),
        credential: credentialRef.optional(),
      }),
    )
    .optional(),
  checks: z.array(CheckSpec).optional(),
  services: z.record(z.string().min(1), ServiceSpec).optional(),
  toolchains: z.record(z.string().min(1), z.union([z.string(), z.number()]).transform(String)).optional(),
});
export type LunaConfig = z.infer<typeof LunaConfig>;

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
  const parsed = LunaConfig.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new PolicyParseError(`${issue.path.join(".") || "file"}: ${issue.message}`);
  }
  const { policy = {}, qa_targets = [], checks, services = {}, toolchains = {} } = parsed.data;
  return {
    qa: policy.qa ?? DEFAULT_POLICY.qa,
    monthlyBudgetUsd: policy.monthly_budget_usd ?? null,
    autoApprovePlanMinutes: policy.auto_approve_plan_minutes ?? null,
    maxConcurrent: policy.max_concurrent ?? null,
    holdoutCases: policy.holdout_cases ?? false,
    qaTargets: qa_targets.map((target) => ({ name: target.name, baseUrl: target.url, credential: target.credential ?? null })),
    checks: checks ?? null,
    services,
    toolchains,
  };
}
