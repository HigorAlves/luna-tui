import { describe, expect, it } from "vitest";

import { fakeGitHub } from "../test/github.ts";
import { designPairsPublished, repoPrivateOf } from "./design-publish.ts";

describe("designPairsPublished (RFC 0013): the repo's rule over GitHub's word on its visibility", () => {
  const task = { repoPath: "/repo", worktreePath: "/wt" };
  const wire = (isPrivate: boolean | Error, publish?: "auto" | "always" | "never") =>
    designPairsPublished({
      github: fakeGitHub({ repoPrivate: async () => { if (isPrivate instanceof Error) throw isPrivate; return isPrivate; } }),
      policies: { for: async () => ({ design: publish ? { parity: { publish } } : undefined }) as never },
      slugOf: async () => "acme/app",
    });

  it("publishes on auto for a private repo and not for a public one", async () => {
    expect(await wire(true)(task)).toBe(true);
    expect(await wire(false)(task)).toBe(false);
  });
  it("follows never and always", async () => {
    expect(await wire(true, "never")(task)).toBe(false);
    expect(await wire(false, "always")(task)).toBe(true);
  });
  it("counts a repo GitHub cannot be asked about as public", async () => {
    expect(await wire(new Error("403"))(task)).toBe(false);
  });
  it("reads null for a repo with no GitHub remote", async () => {
    expect(await repoPrivateOf(fakeGitHub({}), async () => null)("/repo")).toBeNull();
  });
});
