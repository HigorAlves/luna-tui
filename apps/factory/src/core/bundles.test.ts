import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeBundler } from "./bundles.ts";
import { lunaHandlers } from "./luna-tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bundles-")));
  const work = join(root, "work");
  const out = join(root, "out");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  return { root, work, out, base: git(work, "rev-parse", "HEAD") };
}
const commit = (work: string, name: string) => {
  writeFileSync(join(work, name), `${name}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", name);
  return git(work, "rev-parse", "HEAD");
};

describe("the bundles a run leaves for the machine", () => {
  it("writes nothing when nothing was committed since the run started", () => {
    const { work, out } = scratch();
    const bundler = makeBundler({ work, out });
    expect(bundler.bundle()).toBeNull();
    expect(existsSync(join(out, "bundles"))).toBe(false);
  });

  it("writes /out/bundles/<n>.bundle holding the range from the tip the run started at to HEAD, and no half-written file", () => {
    const { work, out, base } = scratch();
    const bundler = makeBundler({ work, out });
    const first = commit(work, "b.txt");
    expect(bundler.bundle()).toBe(join(out, "bundles", "1.bundle"));
    const heads = execFileSync("git", ["bundle", "list-heads", join(out, "bundles", "1.bundle")], { encoding: "utf8" });
    expect(heads).toContain(`${first} HEAD`);
    // It needs the tip the run started at, which the machine's repository has.
    const verified = spawnSync("git", ["-C", work, "bundle", "verify", join(out, "bundles", "1.bundle")], { encoding: "utf8" });
    expect(`${verified.stdout}${verified.stderr}`).toContain(base);
    expect(verified.status).toBe(0);
    const second = commit(work, "c.txt");
    expect(bundler.bundle()).toBe(join(out, "bundles", "2.bundle"));
    expect(execFileSync("git", ["bundle", "list-heads", join(out, "bundles", "2.bundle")], { encoding: "utf8" })).toContain(`${second} HEAD`);
    expect(readdirSync(join(out, "bundles")).sort()).toEqual(["1.bundle", "2.bundle"]);
    // The tip already bundled is not bundled again.
    expect(bundler.bundle()).toBeNull();
  });

  it("is made at each slice the ledger tool records as committed, and not at the other statuses", async () => {
    const { work, out } = scratch();
    const bundler = makeBundler({ work, out });
    const luna = lunaHandlers({ ledgerPath: join(out, "ledger.json"), ledger: { schema: 1, slices: [{ id: 1, title: "s", status: "pending", commit: null }] }, decisions: [], emit: () => {}, onSliceCommitted: () => bundler.bundle() });
    mkdirp(out);
    commit(work, "b.txt");
    await luna.call("slice_set", { id: 1, status: "green" });
    expect(existsSync(join(out, "bundles"))).toBe(false);
    await luna.call("slice_set", { id: 1, status: "committed", commit: "x" });
    expect(readdirSync(join(out, "bundles"))).toEqual(["1.bundle"]);
  });

  it("does not stop the run when it cannot bundle: it answers with the reason", () => {
    const { root, out } = scratch();
    const bundler = makeBundler({ work: join(root, "not-a-repo"), out });
    expect(bundler.bundle()).toBeNull();
  });
});

function mkdirp(path: string): void {
  execFileSync("mkdir", ["-p", path]);
}
