import { describe, expect, it } from "vitest";

import { revertTargets, revertsNothing } from "./revert.ts";

describe("revertTargets", () => {
  it("reads GitHub's revert-PR body: Reverts owner/name#123", () => {
    expect(revertTargets({ title: 'Revert "Add uploader retries"', body: "Reverts Acme/App#123" })).toEqual({ prs: [{ repo: "acme/app", number: 123 }], shas: [] });
  });

  it("reads a bare #123 as the PR's own repository", () => {
    expect(revertTargets({ title: "Revert it", body: "Reverts #77\n\nbecause it broke login" }).prs).toEqual([{ repo: null, number: 77 }]);
  });

  it("reads git's own line: This reverts commit <sha>", () => {
    const t = revertTargets({ title: 'Revert "x"', body: "This reverts commit 0123456789ABCDEF0123456789abcdef01234567.\n\nmore" });
    expect(t).toEqual({ prs: [], shas: ["0123456789abcdef0123456789abcdef01234567"] });
  });

  it("reads both, once each, and caps the list", () => {
    const body = ["Reverts a/b#1", "Reverts a/b#1", ...Array.from({ length: 9 }, (_, i) => `This reverts commit ${String(i + 1).repeat(7)}.`)].join("\n");
    const t = revertTargets({ title: "Revert", body });
    expect(t.prs).toHaveLength(1);
    expect(t.shas).toHaveLength(5);
  });

  it("makes no target from a title alone, a mention in prose or a short sha", () => {
    expect(revertsNothing(revertTargets({ title: 'Revert "Add uploader retries"', body: null }))).toBe(true);
    expect(revertsNothing(revertTargets({ title: "Fix", body: "we should not say Reverts #5 mid-sentence" }))).toBe(true);
    expect(revertsNothing(revertTargets({ title: "Fix", body: "This reverts commit abc12." }))).toBe(true);
  });
});
