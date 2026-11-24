import { describe, expect, it } from "vitest";

import { leftOutOf, parseDiff, splitReviewable } from "./review-diff.ts";

const section = (path: string, lines: string[], head = `diff --git a/${path} b/${path}`) => [head, `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,3 @@", " ctx", ...lines].join("\n") + "\n";

describe("reading a unified diff", () => {
  it("splits it per file with the counts of added and removed lines and the lines of its text", () => {
    const text = section("src/a.ts", ["+one", "+two", "-gone"]) + section("src/b.ts", ["+only"]);
    const files = parseDiff(text);
    expect(files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, lines: f.lines }))).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1, lines: 8 },
      { path: "src/b.ts", additions: 1, deletions: 0, lines: 6 },
    ]);
    expect(files.map((f) => f.text).join("")).toBe(text);
  });

  it("names a renamed file by its new path and keeps the old one, and a deleted file by the old", () => {
    const rename = ["diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts", "--- a/old.ts", "+++ b/new.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const deleted = ["diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-a", ""].join("\n");
    const [r, d] = parseDiff(rename + deleted);
    expect(r).toMatchObject({ path: "new.ts", previousPath: "old.ts", additions: 1, deletions: 1 });
    expect(d).toMatchObject({ path: "gone.ts", deletions: 1 });
  });

  it("does not count a +++ or --- header as a changed line, and reads a binary file as zero lines changed", () => {
    const bin = ["diff --git a/logo.png b/logo.png", "index 1..2 100644", "Binary files a/logo.png and b/logo.png differ", ""].join("\n");
    const [one, two] = parseDiff(section("a.ts", ["+x"]) + bin);
    expect(one).toMatchObject({ additions: 1, deletions: 0 });
    expect(two).toMatchObject({ path: "logo.png", additions: 0, deletions: 0 });
  });

  it("reads an empty diff as no files", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("what a review leaves out", () => {
  it.each([
    ["package-lock.json", "lockfile"],
    ["web/pnpm-lock.yaml", "lockfile"],
    ["yarn.lock", "lockfile"],
    ["board/Cargo.lock", "lockfile"],
    ["poetry.lock", "lockfile"],
    ["Gemfile.lock", "lockfile"],
    ["go.sum", "lockfile"],
    ["composer.lock", "lockfile"],
    ["uv.lock", "lockfile"],
    ["public/app.min.js", "generated"],
    ["public/app.js.map", "generated"],
    ["packages/x/dist/index.js", "generated"],
    ["build/out.js", "generated"],
    ["src/__generated__/types.ts", "generated"],
    ["api/user.pb.go", "generated"],
    ["src/schema_generated.ts", "generated"],
    ["vendor/lib/x.go", "vendored"],
    ["a/node_modules/x/index.js", "vendored"],
    ["third_party/zlib/z.c", "vendored"],
    ["src/__snapshots__/a.test.ts.snap", "snapshot"],
    ["a.snap", "snapshot"],
  ])("leaves out %s as %s", (path, why) => {
    expect(leftOutOf(path)).toBe(why);
  });

  it.each(["src/index.ts", "docs/lock-in.md", "src/locks.ts", "src/distance.ts", "src/builder/x.ts", "Cargo.toml", "package.json"])("reads %s", (path) => {
    expect(leftOutOf(path)).toBeNull();
  });

  it("splits a diff into the files to review and the ones skipped, each skipped file with its line count", () => {
    const text = section("src/a.ts", ["+x"]) + section("pnpm-lock.yaml", ["+a", "+b", "+c"]) + section("dist/app.js", ["+z"]);
    const { reviewable, skipped } = splitReviewable(parseDiff(text));
    expect(reviewable.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(skipped).toEqual([
      { path: "pnpm-lock.yaml", lines: 8, reason: "lockfile" },
      { path: "dist/app.js", lines: 6, reason: "generated" },
    ]);
  });
});
