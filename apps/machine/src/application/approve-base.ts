// A person approves what a repository builds its image from: the exact base reference luna.yaml or the devcontainer names now, or the
// exact key of the Dockerfile its devcontainer builds now (`dockerfile=sha256:<hex>`, computed from the user's checkout, never taken on trust).
import { isDockerfileKey } from "../domain/dockerfile-key.ts";
import { imageSpecOf } from "../domain/image-spec.ts";
import { baseRefusal } from "../domain/sandbox-bounds.ts";
import type { RepoImageSourceOf } from "./repo-image-source.ts";

export interface ApproveBaseDeps {
  knownRepos: () => Promise<string[]>;
  policyOf: (repo: string) => Promise<Parameters<typeof baseRefusal>[0]>;
  sourceOf: (repo: string) => Promise<RepoImageSourceOf>;
  approvals: { approve(repo: string, ref: string): Promise<void> };
  /** What was remembered of the repository's refusals and failures is forgotten. */
  approved: (repo: string) => void;
}

export async function approveRepoBase(deps: ApproveBaseDeps, repo: string, base: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await deps.knownRepos()).includes(repo)) return { ok: false, reason: "the machine does not know that repository" };
  const source = await deps.sourceOf(repo);
  const refusal = baseRefusal(await deps.policyOf(repo)) ?? source.bounds[0] ?? null;
  if (refusal) return { ok: false, reason: refusal };
  if (isDockerfileKey(base)) {
    if (source.dockerfile?.key !== base) return { ok: false, reason: "that is not the Dockerfile in the repository's devcontainer.json now" };
  } else {
    const spec = imageSpecOf({ base: source.base });
    if (spec.kind !== "repo" || spec.base !== base) return { ok: false, reason: "that is not the base in the repository's luna.yaml now" };
  }
  await deps.approvals.approve(repo, base);
  deps.approved(repo);
  return { ok: true };
}
