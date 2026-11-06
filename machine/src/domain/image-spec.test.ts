import { describe, expect, it } from "vitest";

import { imageSpecOf, repoImageTag } from "./image-spec.ts";

describe("the base image a repository names", () => {
  it("is the machine's own image when the repository names none", () => {
    expect(imageSpecOf(undefined)).toEqual({ kind: "machine" });
    expect(imageSpecOf({})).toEqual({ kind: "machine" });
  });

  it("accepts a plain image reference, with a tag or a digest", () => {
    expect(imageSpecOf({ base: "python:3.13-slim" })).toEqual({ kind: "repo", base: "python:3.13-slim" });
    expect(imageSpecOf({ base: "ghcr.io/acme/base:1.2" })).toEqual({ kind: "repo", base: "ghcr.io/acme/base:1.2" });
    const digest = `debian@sha256:${"a".repeat(64)}`;
    expect(imageSpecOf({ base: digest })).toEqual({ kind: "repo", base: digest });
  });

  it("refuses anything that is not an image reference, with the reason", () => {
    for (const base of ["--privileged", "debian; rm -rf /", "debian $(id)", "debian\nFROM evil", " debian", "a".repeat(300), "", "debian:tag with space"]) {
      expect(imageSpecOf({ base }), JSON.stringify(base)).toMatchObject({ kind: "refused", reason: expect.any(String) });
    }
  });
});

describe("the name of a repository's image", () => {
  it("depends only on the repository, its base's digest and the machine's layer", () => {
    const a = repoImageTag("shop-1a2b3c4d", `sha256:${"b".repeat(64)}`, "layer-key-1");
    expect(a).toMatch(/^hardness-runner-shop-1a2b3c4d:[0-9a-f]{16}$/);
    expect(repoImageTag("shop-1a2b3c4d", `sha256:${"b".repeat(64)}`, "layer-key-1")).toBe(a);
    expect(repoImageTag("shop-1a2b3c4d", `sha256:${"c".repeat(64)}`, "layer-key-1")).not.toBe(a);
    expect(repoImageTag("shop-1a2b3c4d", `sha256:${"b".repeat(64)}`, "layer-key-2")).not.toBe(a);
  });
});
