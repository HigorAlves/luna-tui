// Whether the frame | build pairs go out with the PR (RFC 0013, open decision 5): a pair shows a Figma frame to everyone who can read the repo, who may not be the file's viewers.
// `auto` (the default) publishes for a private repository and only lists the pairs for a public one; a repository whose visibility is unknown counts as public. Pure.
import type { DesignConfig } from "@hardness/contracts";

export type PublishRule = "auto" | "always" | "never";

/** The repo's `design.parity.publish`, `auto` when unset or when design is off. */
export const parityPublishRule = (design: DesignConfig | undefined): PublishRule => (design && design !== "off" ? design.parity?.publish : undefined) ?? "auto";

/** `isPrivate` is null when the repository's visibility could not be read. */
export const pairsPublished = (rule: PublishRule, isPrivate: boolean | null): boolean => rule === "always" || (rule === "auto" && isPrivate === true);
