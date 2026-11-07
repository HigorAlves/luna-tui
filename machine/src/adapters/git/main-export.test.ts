import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blobAt, exportRepoCommit, treeAt } from "./main-export.ts";

let dir: string;
let repo: string;
let commit: string;
const git = (...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "main-export-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "# hi");
  writeFileSync(join(repo, "docs", "a.md"), "alpha");
  symlinkSync("/etc/passwd", join(repo, "docs", "passwd.md"));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  commit = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "docs", "a.md"), "dirty edit not committed");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("main-export", () => {
  it("lists regular files of the commit, never links, and reads blobs from the object database", async () => {
    const tree = await treeAt(repo, commit);
    expect(tree.map((e) => e.path).sort()).toEqual(["README.md", "docs/a.md"]);
    const a = tree.find((e) => e.path === "docs/a.md")!;
    expect((await blobAt(repo, a.sha)).toString()).toBe("alpha");
  });

  it("exports the commit with no .git and no links, open to the container's user, leaving the checkout alone", async () => {
    const dest = join(dir, "out", "slug", commit);
    await exportRepoCommit(repo, commit, dest);
    expect(readFileSync(join(dest, "docs", "a.md"), "utf8")).toBe("alpha");
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(dest, "docs", "passwd.md"))).toBe(false);
    expect(lstatSync(join(dest, "docs")).mode & 0o777).toBe(0o777);
    expect(statSync(join(dest, "README.md")).mode & 0o666).toBe(0o666);
    expect(readFileSync(join(repo, "docs", "a.md"), "utf8")).toBe("dirty edit not committed");
    expect(git("status", "--porcelain")).toContain("docs/a.md");
  });

  it("refuses anything that is not a commit id", async () => {
    await expect(exportRepoCommit(repo, "HEAD", join(dir, "x"))).rejects.toThrow("not a commit id");
    await expect(treeAt(repo, "main")).rejects.toThrow("not a commit id");
  });
});
