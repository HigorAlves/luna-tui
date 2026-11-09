import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { linesChangedSince } from "./worktree.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function repo(): { dir: string; first: string } {
  const dir = mkdtempSync(join(tmpdir(), "lines-changed-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "b.ts"), "keep\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return { dir, first: git(dir, "rev-parse", "HEAD") };
}

describe("linesChangedSince", () => {
  it("counts lines added and removed in the anchored files since the anchored commit, and no others", async () => {
    const { dir, first } = repo();
    expect(await linesChangedSince(dir, first, ["a.ts"])).toBe(0);
    writeFileSync(join(dir, "a.ts"), "one\nTWO\nthree\nfour\nfive\n");
    writeFileSync(join(dir, "b.ts"), "changed\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "second");
    // a.ts: one line replaced (1 + 1) and two added (2); b.ts is not anchored.
    expect(await linesChangedSince(dir, first, ["a.ts"])).toBe(4);
    expect(await linesChangedSince(dir, first, ["a.ts", "b.ts"])).toBe(6);
    expect(await linesChangedSince(dir, first, ["nowhere.ts"])).toBe(0);
  });

  it("takes a path as a literal, never a pathspec or an option, and says null for what it cannot read", async () => {
    const { dir, first } = repo();
    writeFileSync(join(dir, "a.ts"), "x\n");
    git(dir, "commit", "-q", "-am", "second");
    expect(await linesChangedSince(dir, first, [":(glob)*.ts"])).toBe(0);
    expect(await linesChangedSince(dir, first, ["--stat"])).toBe(0);
    expect(await linesChangedSince(dir, "deadbeefdeadbeef", ["a.ts"])).toBeNull();
    expect(await linesChangedSince(dir, "not-a-sha", ["a.ts"])).toBeNull();
    expect(await linesChangedSince(dir, first, [])).toBeNull();
    expect(await linesChangedSince(join(dir, "missing"), first, ["a.ts"])).toBeNull();
  });
});
