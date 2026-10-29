// A repo's own say over the pipeline. The policy shape is shared by `luna.yaml`
// (luna-config.ts, the current file) and `PIPELINE.md` (parsed here, deprecated: its front
// matter only ever set the knobs below). Pure: parsing only.
import type { CheckSpec, ServiceSpec } from "@hardness/contracts";

import type { SlaTargets } from "./sla.ts";

/** How a repo's tasks talk to Jira, after its luna.yaml `jira` block (luna-config.ts validates it). */
export interface JiraPolicy {
  /** The project `J` creates issues in and intake's default; null when the repo names none. */
  project: string | null;
  intake: { jql: string; everySecs: number } | null;
  /** Task state to the Jira status name the issue moves to on entering it; only known states survive parsing. */
  on: Partial<Record<string, string>>;
  comments: "none" | "milestones" | "gates";
  /** Per task state, the Jira fields to set with the transition; values may use `{pr_url}`, `{task_id}`, `{branch}`, `{board_url}`. */
  fields: Partial<Record<string, Record<string, string>>>;
  /** The branch pattern for a linked task: `{type}`, `{key}`, `{slug}`, `{route}`, `{id}`. */
  branch: string;
}

export const DEFAULT_JIRA_BRANCH = "{type}/{key}";
export const DEFAULT_JIRA_COMMENTS: JiraPolicy["comments"] = "milestones";

export interface Policy {
  /** `web` runs the e2e stage when the change renders something; `none` never runs it. */
  qa: "web" | "none";
  /** Spend ceiling for this repo over the calendar month; null means none. */
  monthlyBudgetUsd: number | null;
  /** Approve a triage plan by itself after this many minutes, when triage reports high
   *  confidence and no risk; null keeps every plan waiting for you. */
  autoApprovePlanMinutes: number | null;
  /** Running tasks this repo may hold at once; null defers to MACHINE_MAX_PER_REPO. */
  maxConcurrent: number | null;
  /** Keep test_design's cases away from the implementer, so it cannot overfit to them. */
  holdoutCases: boolean;
  /** Where the e2e stage may drive the app, besides the dev server it boots itself. */
  qaTargets: QaTarget[];
  /** The repo's own checks (luna.yaml); null means detect them from the tree. */
  checks: CheckSpec[] | null;
  /** Services run beside every stage and check container, by hostname. */
  services: Record<string, ServiceSpec>;
  /** What the repo says it builds with, by tool; recorded by setup, read by nothing yet. */
  toolchains: Record<string, string>;
  /** The repo's Jira block; null when it has none (its tasks still link by hand, nothing syncs). */
  jira: JiraPolicy | null;
  /** The repo's SLA targets; a field left undefined falls back to the machine's env defaults. */
  sla: Partial<SlaTargets>;
}

/** `qa_target: <name> <base url> [credential ref]`, one line per target; the ref is `env:NAME`. */
export interface QaTarget {
  name: string;
  baseUrl: string;
  credential: string | null;
}

export const DEFAULT_POLICY: Policy = {
  qa: "web",
  monthlyBudgetUsd: null,
  autoApprovePlanMinutes: null,
  maxConcurrent: null,
  holdoutCases: false,
  qaTargets: [],
  checks: null,
  services: {},
  toolchains: {},
  jira: null,
  sla: {},
};

export class PolicyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyParseError";
  }
}

const positiveInt = (key: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new PolicyParseError(`${key} must be a positive integer, got "${raw}"`);
  return value;
};

const positiveUsd = (key: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new PolicyParseError(`${key} must be a positive amount in USD, got "${raw}"`);
  return value;
};

const bool = (key: string, raw: string): boolean => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new PolicyParseError(`${key} must be true or false, got "${raw}"`);
};

/** The front matter between the first two `---` lines, as (line number, key, value) rows. */
function frontMatter(text: string): Array<{ line: number; key: string; value: string }> {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return [];
  const rows: Array<{ line: number; key: string; value: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === "---") return rows;
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) throw new PolicyParseError(`line ${i + 1}: expected key: value, got "${trimmed}"`);
    rows.push({ line: i + 1, key: match[1]!, value: match[2]!.trim() });
  }
  return rows;
}

const qaTarget = (key: string, raw: string): QaTarget => {
  const [name, baseUrl, credential, ...rest] = raw.split(/\s+/).filter(Boolean);
  if (!name || !baseUrl || rest.length > 0) throw new PolicyParseError(`${key} must be "<name> <base url> [credential ref]", got "${raw}"`);
  if (!/^https?:\/\//.test(baseUrl)) throw new PolicyParseError(`${key}: base url must start with http:// or https://, got "${baseUrl}"`);
  if (credential && !/^env:[A-Z_][A-Z0-9_]*$/.test(credential)) throw new PolicyParseError(`${key}: credential must be a reference like env:QA_PASSWORD, never a value`);
  return { name, baseUrl, credential: credential ?? null };
};

/** The policy a PIPELINE.md declares; unknown keys are ignored, a bad value throws. */
export function parsePolicy(text: string): Policy {
  const policy: Policy = { ...DEFAULT_POLICY, qaTargets: [], services: {}, toolchains: {}, sla: {} };
  for (const { key, value } of frontMatter(text)) {
    switch (key) {
      case "qa":
        if (value !== "web" && value !== "none") throw new PolicyParseError(`qa must be web or none, got "${value}"`);
        policy.qa = value;
        break;
      case "monthly_budget_usd":
        policy.monthlyBudgetUsd = positiveUsd(key, value);
        break;
      case "auto_approve_plan_minutes":
        policy.autoApprovePlanMinutes = positiveInt(key, value);
        break;
      case "max_concurrent":
        policy.maxConcurrent = positiveInt(key, value);
        break;
      case "holdout_cases":
        policy.holdoutCases = bool(key, value);
        break;
      case "qa_target":
        policy.qaTargets.push(qaTarget(key, value));
        break;
      default:
        break;
    }
  }
  return policy;
}
