import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { WikiError, noWiki } from "../../application/wiki.ts";
import { exec, execOrThrow } from "../process/exec.ts";
import { createWiki, sharedWiki } from "./wiki.ts";
import { HOST_GIT } from "./worktree.ts";

const SLUG = "acme/widgets";

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const git = (repo: string, ...args: string[]) => execOrThrow("git", [...HOST_GIT, "-C", repo, ...args]);

/** A bare repository standing in for `<slug>.wiki.git`, with `files` committed on `branch`. */
async function bareWiki(files: Record<string, string>, branch = "master"): Promise<string> {
  const bare = join(temp("luna-wiki-bare-"), "wiki.git");
  await execOrThrow("git", [...HOST_GIT, "init", "--bare", "--quiet", `--initial-branch=${branch}`, bare]);
  await commitTo(bare, files, "seed", branch);
  return bare;
}

/** Commits `files` on top of the bare repository's `branch`, as another person would. */
async function commitTo(bare: string, files: Record<string, string>, message: string, branch = "master"): Promise<void> {
  const work = temp("luna-wiki-work-");
  const has = (await exec("git", [...HOST_GIT, "-C", bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  await git(work, "init", "--quiet", `--initial-branch=${branch}`);
  await git(work, "remote", "add", "origin", bare);
  if (has) await git(work, "pull", "--quiet", "origin", branch);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "-m", message);
  await git(work, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
}

const commitsIn = async (bare: string, branch = "master"): Promise<string[]> => (await git(bare, "log", "--format=%s", branch)).split("\n").filter(Boolean);

beforeAll(() => {
  // The identity of the commits the adapter makes: git reads it from here, not from the machine's own config.
  const config = join(temp("luna-wiki-config-"), "gitconfig");
  writeFileSync(config, "[user]\n\tname = Tester\n\temail = tester@example.com\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

function wikiOver(bare: string) {
  return createWiki({ cacheDir: temp("luna-wiki-cache-"), remoteOf: () => bare });
}

describe("the git wiki: reading", () => {
  it("returns every .md page under a prefix, sorted, with paths relative to the wiki root", async () => {
    const bare = await bareWiki({ "Home.md": "home", "adr/0002-b.md": "b", "adr/0001-a.md": "a", "adr/notes.txt": "skip", "other/x.md": "x" });
    const wiki = wikiOver(bare);
    expect(await wiki.readPages(SLUG, "adr/")).toEqual([
      { path: "adr/0001-a.md", text: "a" },
      { path: "adr/0002-b.md", text: "b" },
    ]);
    expect((await wiki.readPages(SLUG, "")).map((p) => p.path)).toEqual(["Home.md", "adr/0001-a.md", "adr/0002-b.md", "other/x.md"]);
  });

  it("follows the remote's default branch, whatever its name", async () => {
    const wiki = wikiOver(await bareWiki({ "Home.md": "home" }, "trunk"));
    expect(await wiki.readPages(SLUG, "")).toEqual([{ path: "Home.md", text: "home" }]);
  });

  it("sees what changed on the remote since the last use", async () => {
    const bare = await bareWiki({ "Home.md": "one" });
    const wiki = wikiOver(bare);
    await wiki.readPages(SLUG, "");
    await commitTo(bare, { "Home.md": "two" }, "edit");
    expect(await wiki.readPages(SLUG, "")).toEqual([{ path: "Home.md", text: "two" }]);
  });

  it("maps a wiki that was never created to an error that says how to create it", async () => {
    const wiki = createWiki({ cacheDir: temp("luna-wiki-cache-"), remoteOf: () => join(temp("luna-wiki-none-"), "missing.git") });
    await expect(wiki.readPages(SLUG, "")).rejects.toThrow(`the wiki of ${SLUG} does not exist yet: open the repo's Wiki tab on GitHub and create the first page`);
    await expect(wiki.readPages(SLUG, "")).rejects.toBeInstanceOf(WikiError);
  });
});

describe("the git wiki: paths", () => {
  it.each(["/abs.md", "../escape.md", "a/../../escape.md", "notes.txt", "dir/", ""])("rejects the page path %j before touching git", async (path) => {
    const cacheDir = temp("luna-wiki-cache-");
    const wiki = createWiki({ cacheDir, remoteOf: () => "/nonexistent" });
    await expect(wiki.writePages(SLUG, [{ path, text: "x" }], "m")).rejects.toBeInstanceOf(WikiError);
    expect(existsSync(join(cacheDir, "acme__widgets"))).toBe(false);
  });

  it("rejects a prefix that climbs out of the wiki", async () => {
    const wiki = createWiki({ cacheDir: temp("luna-wiki-cache-"), remoteOf: () => "/nonexistent" });
    await expect(wiki.readPages(SLUG, "../")).rejects.toBeInstanceOf(WikiError);
  });

  it("rejects a slug that is not owner/name", async () => {
    const wiki = wikiOver(await bareWiki({ "Home.md": "h" }));
    await expect(wiki.readPages("nope", "")).rejects.toBeInstanceOf(WikiError);
  });
});

describe("the git wiki: writing", () => {
  it("writes the pages in one commit that the remote has", async () => {
    const bare = await bareWiki({ "Home.md": "home" });
    const wiki = wikiOver(bare);
    const { sha } = await wiki.writePages(SLUG, [{ path: "adr/0001-a.md", text: "a" }, { path: "Guide.md", text: "g" }], "docs: add pages");
    expect(await commitsIn(bare)).toEqual(["docs: add pages", "seed"]);
    expect(await git(bare, "rev-parse", "master")).toBe(sha);
    expect(await git(bare, "show", "master:adr/0001-a.md")).toBe("a");
    expect(await git(bare, "log", "-1", "--format=%an <%ae>", "master")).toBe("Tester <tester@example.com>");
  });

  it("makes no commit for pages that are unchanged and returns the current sha", async () => {
    const bare = await bareWiki({ "Home.md": "home" });
    const wiki = wikiOver(bare);
    const before = await git(bare, "rev-parse", "master");
    expect(await wiki.writePages(SLUG, [{ path: "Home.md", text: "home" }], "no-op")).toEqual({ sha: before });
    expect(await commitsIn(bare)).toEqual(["seed"]);
  });

  it("serializes concurrent writes to one slug: both land, in call order", async () => {
    const bare = await bareWiki({ "Home.md": "home" });
    const wiki = wikiOver(bare);
    await Promise.all([wiki.writePages(SLUG, [{ path: "A.md", text: "a" }], "first"), wiki.writePages(SLUG, [{ path: "B.md", text: "b" }], "second")]);
    expect(await commitsIn(bare)).toEqual(["second", "first", "seed"]);
  });

  it("rebases onto a remote that moved ahead between the sync and the push, then pushes", async () => {
    const bare = await bareWiki({ "Home.md": "home" });
    let raced = false;
    const wiki = createWiki({
      cacheDir: temp("luna-wiki-cache-"),
      remoteOf: () => bare,
      // Someone else pushes after the adapter synced, so the push is the first it hears of it.
      afterSync: async () => {
        if (raced) return;
        raced = true;
        await commitTo(bare, { "Late.md": "l" }, "raced");
      },
    });
    const { sha } = await wiki.writePages(SLUG, [{ path: "Mine.md", text: "m" }], "mine");
    expect(await commitsIn(bare)).toEqual(["mine", "raced", "seed"]);
    expect(await git(bare, "rev-parse", "master")).toBe(sha);
  });
});

describe("noWiki", () => {
  it("rejects every call with the reason", async () => {
    const wiki = noWiki("no git host");
    await expect(wiki.readPages(SLUG, "")).rejects.toThrow("no git host");
    await expect(wiki.writePages(SLUG, [], "m")).rejects.toBeInstanceOf(WikiError);
  });
});

describe("sharedWiki", () => {
  it("gives every caller with one state dir the same wiki, so its per-repo lock and cache are one", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "wiki-shared-"));
    expect(sharedWiki(stateDir)).toBe(sharedWiki(stateDir));
    expect(sharedWiki(stateDir)).not.toBe(sharedWiki(mkdtempSync(join(tmpdir(), "wiki-shared-"))));
  });
});
