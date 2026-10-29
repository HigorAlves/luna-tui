import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepoMap, originSlug } from "./repo-map.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function reposDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "repos-"));
  dirs.push(dir);
  return dir;
}

function gitRepo(parent: string, name: string, origin: string | null): string {
  const dir = join(parent, name);
  mkdirSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

describe("originSlug", () => {
  it("reads owner/name from ssh and https GitHub remotes, with or without .git", () => {
    expect(originSlug("git@github.com:Owner/Name.git")).toBe("Owner/Name");
    expect(originSlug("https://github.com/owner/name")).toBe("owner/name");
    expect(originSlug("https://github.com/owner/name.git\n")).toBe("owner/name");
    expect(originSlug("ssh://git@github.com/owner/name.git")).toBe("owner/name");
    expect(originSlug("https://gitlab.com/owner/name.git")).toBeNull();
    expect(originSlug("")).toBeNull();
  });
});

describe("RepoMap.resolve", () => {
  it("answers from the explicit map first", async () => {
    const map = new RepoMap({ map: { "o/a": "/explicit/a" }, reposDir: reposDir() });
    expect(await map.resolve("o/a")).toBe("/explicit/a");
  });

  it("finds a checkout under the repos dir by its origin, case-insensitively, and remembers it", async () => {
    const root = reposDir();
    gitRepo(root, "other", "git@github.com:o/other.git");
    const a = gitRepo(root, "a-checkout", "https://github.com/O/A.git");
    gitRepo(root, "no-origin", null);
    mkdirSync(join(root, "not-a-repo"));
    const map = new RepoMap({ map: {}, reposDir: root });
    expect(await map.resolve("o/a")).toBe(a);
    rmSync(a, { recursive: true, force: true });
    expect(await map.resolve("o/a")).toBe(a);
  });

  it("is null for a repo nothing matches, and for a repos dir that does not exist", async () => {
    expect(await new RepoMap({ map: {}, reposDir: reposDir() }).resolve("o/none")).toBeNull();
    expect(await new RepoMap({ map: {}, reposDir: "/nowhere/at/all" }).resolve("o/none")).toBeNull();
  });
});

describe("RepoMap two levels down", () => {
  it("finds a checkout in a folder of checkouts (projects/orc) but does not descend into a checkout", async () => {
    const root = reposDir();
    mkdirSync(join(root, "projects"));
    const orc = gitRepo(join(root, "projects"), "orc", "https://github.com/o/orc.git");
    mkdirSync(join(orc, "vendored"));
    gitRepo(join(orc, "vendored"), "inner", "https://github.com/o/inner.git");
    const map = new RepoMap({ map: {}, reposDir: root });
    expect(await map.resolve("o/orc")).toBe(orc);
    expect(await map.resolve("o/inner")).toBeNull();
  });
});

describe("RepoMap links that outlive a restart", () => {
  it("writes what it was told to remember and reads it back in a new instance", async () => {
    const root = reposDir();
    const checkout = gitRepo(root, "workbench", "https://github.com/o/Foundry");
    const file = join(root, "links.json");
    const first = new RepoMap({ map: {}, reposDir: join(root, "nowhere"), file });
    expect(await first.resolve("o/workbench")).toBeNull();
    first.remember("o/workbench", checkout);
    await first.saved();
    const second = new RepoMap({ map: {}, reposDir: join(root, "nowhere"), file });
    expect(await second.resolve("O/Workbench")).toBe(checkout);
  });

  it("drops a saved link whose folder is gone, and survives a damaged file", async () => {
    const root = reposDir();
    const file = join(root, "links.json");
    writeFileSync(file, JSON.stringify({ "o/gone": join(root, "deleted") }));
    expect(await new RepoMap({ map: {}, reposDir: root, file }).resolve("o/gone")).toBeNull();
    writeFileSync(file, "{ not json");
    expect(await new RepoMap({ map: {}, reposDir: root, file }).resolve("o/gone")).toBeNull();
  });
});
