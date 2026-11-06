import { describe, expect, it } from "vitest";

import { controlPlaneFiles, isControlPlane } from "./control-plane.ts";

describe("isControlPlane: the files that decide who may change what", () => {
  it.each([
    ".github/workflows/release.yml", ".github/CODEOWNERS", ".github/dependabot.yml", "CODEOWNERS", "docs/CODEOWNERS", "luna.yaml", "apps/web/luna.yaml", "PIPELINE.md",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "board/Cargo.lock", "go.sum", "poetry.lock", "Gemfile.lock", "composer.lock", "bun.lockb",
    ".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile",
  ])("%s is", (path) => expect(isControlPlane(path)).toBe(true));

  it.each(["src/cart.ts", "docs/github.md", "src/.github-notes.md", "lockfile.ts", "src/CODEOWNERS.md", "my-luna.yaml.bak", "README.md"])("%s is not", (path) => expect(isControlPlane(path)).toBe(false));

  it("reads a path as written: a leading ./ is nothing, and the case of a name is its own", () => {
    expect(isControlPlane("./.github/workflows/ci.yml")).toBe(true);
    expect(isControlPlane("codeowners")).toBe(false);
  });

  it("lists the control-plane files among some, once each, in order", () => {
    expect(controlPlaneFiles(["src/a.ts", "pnpm-lock.yaml", ".github/workflows/x.yml", "pnpm-lock.yaml"])).toEqual(["pnpm-lock.yaml", ".github/workflows/x.yml"]);
    expect(controlPlaneFiles(["src/a.ts"])).toEqual([]);
  });
});
