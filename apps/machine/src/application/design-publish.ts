// Whether the design pairs go out with the PR (RFC 0013): the repo's `design.parity.publish` over what GitHub says about its visibility. Deliver reads it to word the PR block, Evidence to add the media.
import { type PublishRule, pairsPublished, parityPublishRule } from "../domain/parity-publish.ts";
import type { Policy } from "../domain/policy.ts";
import type { GitHub } from "./github.ts";

/** Whether the repository at `path` is private on GitHub; null when it has no GitHub remote or GitHub cannot say. */
export const repoPrivateOf = (github: Pick<GitHub, "repoPrivate">, slugOf: (path: string) => Promise<string | null>) => async (path: string | null): Promise<boolean | null> => {
  const slug = path ? await slugOf(path).catch(() => null) : null;
  return slug ? await github.repoPrivate(slug).catch(() => null) : null;
};

export interface DesignPublishDeps {
  github: Pick<GitHub, "repoPrivate">;
  policies: { for: (repoPath: string | null) => Promise<Partial<Pick<Policy, "design">>> };
  slugOf: (path: string) => Promise<string | null>;
}

/** The rule's answer for a card: the pairs are published (`always`, or `auto` on a private repository) or listed on the board only. */
export const designPairsPublished = (deps: DesignPublishDeps) => async (task: { repoPath: string | null }): Promise<boolean> => {
  const rule: PublishRule = parityPublishRule((await deps.policies.for(task.repoPath).catch((): Partial<Pick<Policy, "design">> => ({}))).design);
  return pairsPublished(rule, rule === "auto" ? await repoPrivateOf(deps.github, deps.slugOf)(task.repoPath) : null);
};
