// The structural gates GitHub enforces whatever an agent does: the repository ruleset
// `scripts/github-gates.mjs` applies to a repo's default branch. Pure: the payload only.
// The pipeline cannot approve its own PR because approval must come from someone other
// than the last pusher, and a review goes stale when the branch moves.

export const RULESET_NAME = "hardness gates";

export interface GatesOptions {
  defaultBranch: string;
  /** Check contexts a PR must have green before it merges; none means no such rule. */
  requiredChecks?: string[];
}

export type Rule =
  | { type: "deletion" }
  | { type: "non_fast_forward" }
  | {
      type: "pull_request";
      parameters: {
        required_approving_review_count: number;
        require_last_push_approval: boolean;
        dismiss_stale_reviews_on_push: boolean;
        require_code_owner_review: boolean;
        required_review_thread_resolution: boolean;
      };
    }
  | {
      type: "required_status_checks";
      parameters: {
        strict_required_status_checks_policy: boolean;
        required_status_checks: Array<{ context: string }>;
      };
    };

export interface Ruleset {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Rule[];
}

/** The ruleset for `POST /repos/{owner}/{repo}/rulesets` (or `PUT .../rulesets/{id}` to update). */
export function rulesetFor(options: GatesOptions): Ruleset {
  const rules: Rule[] = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        require_last_push_approval: true,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        required_review_thread_resolution: false,
      },
    },
  ];
  const checks = options.requiredChecks ?? [];
  if (checks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: checks.map((context) => ({ context })),
      },
    });
  }
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${options.defaultBranch}`], exclude: [] } },
    rules,
  };
}
