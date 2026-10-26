import { describe, expect, it } from "vitest";

import { RULESET_NAME, rulesetFor } from "./github-gates.ts";

describe("rulesetFor", () => {
  it("guards the default branch: a review from someone else, fresh after the last push, no deletion, no force-push", () => {
    const ruleset = rulesetFor({ defaultBranch: "main", requiredChecks: ["board", "machine"] });
    expect(ruleset.name).toBe(RULESET_NAME);
    expect(ruleset.target).toBe("branch");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.conditions).toEqual({ ref_name: { include: ["refs/heads/main"], exclude: [] } });
    const rules = Object.fromEntries(ruleset.rules.map((r) => [r.type, "parameters" in r ? r.parameters : true]));
    expect(rules.deletion).toBe(true);
    expect(rules.non_fast_forward).toBe(true);
    expect(rules.pull_request).toMatchObject({
      required_approving_review_count: 1,
      require_last_push_approval: true,
      dismiss_stale_reviews_on_push: true,
    });
    expect(rules.required_status_checks).toEqual({
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "board" }, { context: "machine" }],
    });
  });

  it("leaves the status-check rule out when no checks are named", () => {
    const ruleset = rulesetFor({ defaultBranch: "trunk" });
    expect(ruleset.rules.map((r) => r.type)).toEqual(["deletion", "non_fast_forward", "pull_request"]);
    expect(ruleset.conditions.ref_name.include).toEqual(["refs/heads/trunk"]);
  });
});
