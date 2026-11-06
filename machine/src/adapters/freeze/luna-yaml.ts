import type { FreezeSource } from "../../application/freeze.ts";
import type { Policy } from "../../domain/policy.ts";

/** The freeze windows of the repository's own `luna.yaml` (`freeze[]`), read from the user's checkout, never a card's workspace. */
export const lunaYamlFreeze = (policies: { for: (repoPath: string | null) => Promise<Pick<Policy, "freeze">> }): FreezeSource => ({
  windows: async (repoPath) => (await policies.for(repoPath)).freeze,
});
