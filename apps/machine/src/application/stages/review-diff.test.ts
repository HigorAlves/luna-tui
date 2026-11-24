import { describe, expect, it } from "vitest";

import { type DiffFile, capShards, leftOutOf, parseDiff, shardDiff, splitReviewable } from "./review-diff.ts";

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

/** A file of `n` changed lines in one hunk, so its section has n + 4 lines. */
const file = (path: string, n: number): DiffFile => parseDiff(section(path, Array.from({ length: n }, (_, i) => `+l${i}`)).replace("@@ -1,2 +1,3 @@\n ctx\n", "@@ -1 +1 @@\n"))[0]!;
/** A file of several hunks of `per` lines each. */
const hunked = (path: string, hunks: number, per: number): DiffFile => {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const body = Array.from({ length: hunks }, (_, h) => `@@ -${h * 100 + 1} +${h * 100 + 1} @@\n` + Array.from({ length: per - 1 }, (_, i) => `+h${h}l${i}`).join("\n") + "\n").join("");
  return parseDiff(head + body)[0]!;
};
const paths = (shard: { parts: Array<{ path: string }> }) => shard.parts.map((p) => p.path);

describe("cutting a diff into shards by module", () => {
  it("is one shard when everything fits", () => {
    const shards = shardDiff([file("a/x.ts", 10), file("b/y.ts", 10)], 1000);
    expect(shards).toHaveLength(1);
    expect(paths(shards[0]!)).toEqual(["a/x.ts", "b/y.ts"]);
    expect(shards[0]!.lines).toBe(28);
  });

  it("keeps a directory together when it fits and starts the next shard rather than splitting it", () => {
    // each file is 54 lines; the directories hold 108, 54 and 108.
    const files = [file("a/1.ts", 50), file("a/2.ts", 50), file("b/1.ts", 50), file("c/1.ts", 50), file("c/2.ts", 50)];
    const shards = shardDiff(files, 170);
    expect(shards.map(paths)).toEqual([["a/1.ts", "a/2.ts", "b/1.ts"], ["c/1.ts", "c/2.ts"]]);
    expect(shards.map((s) => s.modules)).toEqual([["a", "b"], ["c"]]);
  });

  it("splits a directory too big for one shard by file, in the diff's order", () => {
    const files = [1, 2, 3, 4, 5].map((i) => file(`big/f${i}.ts`, 46));
    const shards = shardDiff(files, 110);
    expect(shards.map(paths)).toEqual([["big/f1.ts", "big/f2.ts"], ["big/f3.ts", "big/f4.ts"], ["big/f5.ts"]]);
  });

  it("gives a file bigger than a shard shards of its own, cut at hunk boundaries, each piece with the file's header", () => {
    const big = hunked("src/huge.ts", 6, 100); // 3 header lines + 6 hunks of 100 lines
    const shards = shardDiff([file("a/x.ts", 10), big, file("z/y.ts", 10)], 250);
    const huge = shards.filter((s) => s.parts.some((p) => p.path === "src/huge.ts"));
    expect(huge.length).toBe(3);
    for (const s of huge) {
      expect(s.parts).toHaveLength(1);
      expect(s.parts[0]!.text.startsWith("diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n@@")).toBe(true);
      expect(s.lines).toBeLessThanOrEqual(250);
    }
    expect(huge.map((s) => s.parts[0]!.piece)).toEqual([{ n: 1, of: 3 }, { n: 2, of: 3 }, { n: 3, of: 3 }]);
    // Every changed line of the file is in exactly one piece.
    const all = huge.map((s) => s.parts[0]!.text).join("\n");
    for (let h = 0; h < 6; h++) expect(all.match(new RegExp(`^\\+h${h}l0$`, "gm"))).toHaveLength(1);
    // Neighbours are not mixed into its shards.
    expect(shards.flatMap(paths).filter((p) => p !== "src/huge.ts").sort()).toEqual(["a/x.ts", "z/y.ts"]);
  });

  it("puts a single hunk bigger than a shard in a shard by itself rather than cutting it", () => {
    const shards = shardDiff([file("a/one.ts", 400)], 100);
    expect(shards).toHaveLength(1);
    expect(shards[0]!.lines).toBe(404);
  });

  it("also cuts by characters, so a few very long lines do not make a shard the prompt would truncate", () => {
    const wide = (path: string) => parseDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${"x".repeat(60_000)}\n`)[0]!;
    const shards = shardDiff([wide("a/1.js"), wide("a/2.js"), wide("a/3.js")], 4000, 130_000);
    expect(shards.map(paths)).toEqual([["a/1.js", "a/2.js"], ["a/3.js"]]);
  });

  it("numbers the shards from 1 and counts no file twice", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`m${i % 6}/f${i}.ts`, 20));
    const shards = shardDiff(files, 100);
    expect(shards.map((s) => s.index)).toEqual(shards.map((_, i) => i + 1));
    expect(shards.flatMap(paths).sort()).toEqual(files.map((f) => f.path).sort());
  });
});

describe("keeping the shards a review can afford", () => {
  const shard = (n: number, ...ps: string[]) => shardDiff(ps.map((p) => file(p, n)), 10_000)[0]!;

  it("keeps all of them under the cap and lists nothing as unreviewed", () => {
    const shards = [shard(5, "src/a.ts"), shard(5, "src/b.ts")];
    expect(capShards(shards, 2)).toMatchObject({ kept: shards, unreviewed: [] });
  });

  it("over the cap keeps security paths first, then source over tests over docs, then the bigger", () => {
    const docs = shard(500, "docs/guide.md");
    const tests = shard(500, "src/a.test.ts");
    const small = shard(10, "src/small.ts");
    const big = shard(300, "src/big.ts");
    const auth = shard(5, "src/auth/login.ts");
    const { kept, unreviewed } = capShards([docs, tests, small, big, auth], 3);
    expect(kept.map(paths)).toEqual([["src/small.ts"], ["src/big.ts"], ["src/auth/login.ts"]]);
    expect(unreviewed).toEqual([
      { path: "src/a.test.ts", lines: 504 },
      { path: "docs/guide.md", lines: 504 },
    ]);
  });

  it("hands the kept shards back in the diff's own order, renumbered", () => {
    const a = shard(5, "a/docs.md");
    const b = shard(5, "b/routes/api.ts");
    const c = shard(5, "c/x.ts");
    const { kept } = capShards([a, b, c], 2);
    expect(kept.map(paths)).toEqual([["b/routes/api.ts"], ["c/x.ts"]]);
    expect(kept.map((s) => s.index)).toEqual([1, 2]);
  });

  it("lists the lines of a cut file's unreviewed pieces under its path", () => {
    const shards = shardDiff([hunked("src/auth/huge.ts", 4, 100), file("src/other.ts", 5)], 150);
    const { unreviewed } = capShards(shards, 1);
    expect(unreviewed.map((u) => u.path)).toContain("src/auth/huge.ts");
    expect(unreviewed.reduce((n, u) => n + u.lines, 0)).toBeGreaterThan(0);
  });
});
