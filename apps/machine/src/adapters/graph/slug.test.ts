import { describe, expect, it } from "vitest";

import { repoSlug } from "./slug.ts";

describe("repoSlug", () => {
  it("tells two repos with the same name apart", () => {
    expect(repoSlug("/a/api")).not.toBe(repoSlug("/b/api"));
  });
  it("keeps the name and is one safe path segment", () => {
    const slug = repoSlug("/some dir/My Repo!");
    expect(slug).toMatch(/^my-repo-[0-9a-f]{8}$/);
    expect(slug).not.toContain("/");
  });
  it("is stable for the same path", () => {
    expect(repoSlug("/a/api")).toBe(repoSlug("/a/api/"));
  });
});
