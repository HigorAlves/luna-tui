// How far a card's source is trusted. A GitHub issue or PR from someone outside the repository's own people is text from a stranger:
// the card still runs, but in its own cache volume and, when the owner's policy says so, under another container runtime.
import type { TaskSource } from "@hardness/contracts";

export type Trust = "trusted" | "untrusted";

/** GitHub's `author_association` values that name the repository's own people. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The task note for an untrusted card: what sets it apart (its own cache; the runtime when the policy names one). */
export function untrustedNote(size: { cacheTrust?: Trust; runtime?: string; released?: boolean }): string {
  const parts = [size.cacheTrust === "untrusted" ? "its own cache volume" : "the shared cache volume (cache.split_by_trust is off)", `the ${size.runtime ?? "runc"} container runtime`];
  const why = size.released ? "a person released this ticket after the safety screen held it" : "its GitHub author is not an owner, member or collaborator";
  return `This card runs untrusted (${why}): ${parts.join(" and ")}.`;
}

/** True for a card whose ticket the safety screen held and a person released: whatever its source, it runs untrusted. */
export const safetyReleasedOf = (source: TaskSource | null | undefined): boolean => (source as { safetyReleased?: boolean } | null | undefined)?.safetyReleased === true;

/** `untrusted` for a card whose ticket a person released from the safety hold, whatever its source; for a GitHub issue or PR with no recorded association, or one outside `OWNER|MEMBER|COLLABORATOR`; `trusted` for every other source. Pure. */
export function trustOf(task: { source?: TaskSource | null }): Trust {
  const source = task.source;
  if (safetyReleasedOf(source)) return "untrusted";
  if (!source || (source.kind !== "github" && source.kind !== "github_pr")) return "trusted";
  return TRUSTED_ASSOCIATIONS.has(source.authorAssociation ?? "") ? "trusted" : "untrusted";
}
