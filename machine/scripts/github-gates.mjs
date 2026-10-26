#!/usr/bin/env node
// Applies the "hardness gates" ruleset to a repo's default branch, so the structural rules
// hold whatever an agent does: one approving review from someone other than the last pusher,
// reviews dismissed when the branch moves, no deletion, no force-push, and (when named) the
// CI checks that must be green. Creates the ruleset or updates the one with that name.
//
//   node machine/scripts/github-gates.mjs owner/name [--checks board,machine] [--dry-run]
//
// Needs `gh` signed in as someone who administers the repo.
import { execFileSync } from "node:child_process";

import { RULESET_NAME, rulesetFor } from "../src/domain/github-gates.ts";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("usage: github-gates.mjs owner/name [--checks a,b] [--dry-run]");
  process.exit(2);
}
const dryRun = args.includes("--dry-run");
const checksArg = args.find((a) => a.startsWith("--checks="))?.slice("--checks=".length) ?? args[args.indexOf("--checks") + 1];
const requiredChecks = args.includes("--checks") || args.some((a) => a.startsWith("--checks="))
  ? (checksArg ?? "").split(",").map((c) => c.trim()).filter(Boolean)
  : [];

const gh = (a, input) => execFileSync("gh", a, { encoding: "utf8", ...(input === undefined ? {} : { input }) });

const defaultBranch = JSON.parse(gh(["repo", "view", repo, "--json", "defaultBranchRef"])).defaultBranchRef.name;
const ruleset = rulesetFor({ defaultBranch, requiredChecks });
const existing = JSON.parse(gh(["api", `repos/${repo}/rulesets`])).find((r) => r.name === RULESET_NAME);

if (dryRun) {
  console.log(`${existing ? "would update" : "would create"} ruleset "${RULESET_NAME}" on ${repo} (${defaultBranch}):`);
  console.log(JSON.stringify(ruleset, null, 2));
  process.exit(0);
}
const method = existing ? "PUT" : "POST";
const path = existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`;
const result = JSON.parse(gh(["api", "-X", method, path, "-H", "Accept: application/vnd.github+json", "--input", "-"], JSON.stringify(ruleset)) || "{}");
console.log(`${existing ? "updated" : "created"} ruleset "${RULESET_NAME}" (#${result.id ?? existing?.id}) on ${repo}: ${defaultBranch} needs a review from someone else, fresh after the last push; no deletion, no force-push${requiredChecks.length ? `; checks ${requiredChecks.join(", ")}` : ""}.`);
