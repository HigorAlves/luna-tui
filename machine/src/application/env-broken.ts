// The errors a sandbox step throws when the environment, not the change, is what failed, as the `env_broken` escalation detail every stage
// gives (step `install`, `secrets` or `network`). One place, so the sweep, Verify and the agent path name the same steps.
import { SecretsMissingError } from "../adapters/docker/docker.ts";
import { EgressUnsupportedError } from "../adapters/docker/egress.ts";
import { InstallFailedError } from "./install.ts";

/** The escalation detail when git resolves no `user.name` and `user.email` for a repository: a suite that commits in a scratch repo, and the machine's own commits, would fail as nobody. Verify and the sweep give the same one. */
export function noIdentityDetail(where: string): Record<string, unknown> {
  return {
    escalation: "env_broken",
    envBroken: true,
    step: "checks",
    reason: `git has no identity for ${where}: set user.name and user.email (git config) so checks and commits run as you`,
    options: ["git config user.name / user.email in the repo or globally, then approve"],
  };
}

/** The escalation detail for such an error; null for any other error (the caller rethrows it). */
export function envBrokenDetail(error: unknown): Record<string, unknown> | null {
  if (error instanceof InstallFailedError || error instanceof SecretsMissingError) return error.detail;
  if (error instanceof EgressUnsupportedError) return { escalation: "env_broken", envBroken: true, step: "network", reason: error.message, options: ["install Docker Engine 28.0 or newer, or set MACHINE_EGRESS=off on the machine to run without the allow-list, then resume"] };
  return null;
}
