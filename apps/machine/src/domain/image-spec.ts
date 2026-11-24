// The base image a repository names in its own luna.yaml (`sandbox.image.base`), and the name of the image the
// machine builds from it. The value is repo-controlled text: it is checked here, before it can reach a docker
// command line, and it only ever travels as one argv element (never through a shell).
import { createHash } from "node:crypto";

export type ImageSpec = { kind: "machine" } | { kind: "repo"; base: string } | { kind: "refused"; reason: string };

const MAX_REFERENCE = 255;
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REFERENCE = new RegExp(
  `^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?/)?${COMPONENT}(?:/${COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);

/** What a repository's `sandbox.image` means: the machine's own image when it names none, else a checked base. */
export function imageSpecOf(image: { base?: string | null } | null | undefined): ImageSpec {
  const base = image?.base;
  if (base === undefined || base === null) return { kind: "machine" };
  if (typeof base !== "string" || base.length === 0) return { kind: "refused", reason: "the base image is empty" };
  if (base.length > MAX_REFERENCE) return { kind: "refused", reason: `the base image reference is longer than ${MAX_REFERENCE} characters` };
  if (!REFERENCE.test(base)) return { kind: "refused", reason: "the base image is not a plain image reference (registry/repository, then a tag or a sha256 digest)" };
  return { kind: "repo", base };
}

/** The tag of a repository's image: the same repository, base digest and machine layer always give the same name. */
export function repoImageTag(slug: string, baseDigest: string, layerKey: string): string {
  const hash = createHash("sha256").update(JSON.stringify([slug, baseDigest, layerKey])).digest("hex").slice(0, 16);
  return `hardness-runner-${slug}:${hash}`;
}
