import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { noMemory } from "./memory.ts";
import { MemorySync, type RepoGit } from "./memory-sync.ts";

const C1 = "a".repeat(40);
const C2 = "b".repeat(40);

/** A repository as a map of path to content; a blob's id is its content. */
function fakeGit(files: Record<string, string>): RepoGit & { files: Record<string, string>; head_: string; exports: string[] } {
  const git = {
    files,
    head_: C1,
    exports: [] as string[],
    head: async () => git.head_,
    tree: async () => Object.entries(git.files).map(([path, content]) => ({ path, sha: `sha:${content}`, size: Buffer.byteLength(content) })),
    blob: async (_repo: string, sha: string) => Buffer.from(sha.slice(4)),
    exportTo: async (_repo: string, commit: string, dest: string) => {
      git.exports.push(commit);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "main.ts"), "export {}");
    },
  };
  return git;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-sync-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setup = (files: Record<string, string>, memory = fakeMemory()) => {
  const git = fakeGit(files);
  const logs: string[] = [];
  const sync = new MemorySync({ memory, git, slugOf: () => "app-1a2b3c4d", dir, log: (m) => logs.push(m) });
  return { memory, git, sync, logs };
};

describe("MemorySync documents", () => {
  it("sends the README and the docs tree from the commit, and only those", async () => {
    const { memory, sync } = setup({ "README.md": "# app", "docs/a.md": "alpha", "docs/rfcs/0001.md": "rfc", "src/readme.md": "no", "docs/img.png": "x", "CHANGELOG.md": "no" });
    const report = await sync.sync("/repo");
    expect(report?.docs).toMatchObject({ added: 3, changed: 0, removed: 0 });
    expect(memory.docs.map((d) => d.path).sort()).toEqual(["README.md", "docs/a.md", "docs/rfcs/0001.md"]);
    expect(memory.items[0]).toMatchObject({ repo: "app-1a2b3c4d", anchors: { files: [expect.any(String)], commit: C1 } });
    expect(memory.cognified).toEqual([["app-1a2b3c4d:docs"]]);
  });

  it("sends only what changed on the next commit, retires what was deleted, and cognifies once", async () => {
    const { memory, git, sync } = setup({ "README.md": "one", "docs/a.md": "alpha", "docs/gone.md": "bye" });
    await sync.sync("/repo");
    git.head_ = C2;
    git.files = { "README.md": "one", "docs/a.md": "alpha v2", "docs/new.md": "fresh" };
    const report = await sync.sync("/repo");
    expect(report?.docs).toMatchObject({ added: 1, changed: 1, removed: 1, unchanged: 1 });
    expect(memory.docs.slice(3).map((d) => d.path).sort()).toEqual(["docs/a.md", "docs/new.md"]);
    expect(memory.items.find((i) => i.source.ref === "docs/gone.md")?.status).toBe("retired");
    expect(memory.cognified).toHaveLength(2);
  });

  it("does nothing, and does not cognify, when nothing changed", async () => {
    const { memory, sync } = setup({ "docs/a.md": "alpha" });
    await sync.sync("/repo");
    const report = await sync.sync("/repo");
    expect(report).toMatchObject({ docs: { unchanged: 1, added: 0 }, code: "unchanged" });
    expect(memory.cognified).toHaveLength(1);
  });

  it("sends a document again when memory lost it", async () => {
    const { memory, sync } = setup({ "docs/a.md": "alpha" });
    await sync.sync("/repo");
    memory.items[0]!.status = "retired";
    const report = await sync.sync("/repo");
    expect(report?.docs.changed).toBe(1);
    expect(memory.docs).toHaveLength(2);
  });

  it("skips a document over the size cap and counts it", async () => {
    const { memory, sync } = setup({ "docs/big.md": "x".repeat(1024 * 1024 + 1), "docs/ok.md": "ok" });
    const report = await sync.sync("/repo");
    expect(report?.docs).toMatchObject({ added: 1, skipped: 1 });
    expect(memory.docs.map((d) => d.path)).toEqual(["docs/ok.md"]);
  });

  it("does nothing with memory off", async () => {
    const { git, sync } = setup({ "docs/a.md": "alpha" }, noMemory() as never);
    expect(await sync.sync("/repo")).toBeNull();
    expect(git.exports).toEqual([]);
  });
});

describe("MemorySync code graph", () => {
  it("exports the commit, ingests it under the container's root, and drops the previous commit's folder", async () => {
    const { memory, git, sync } = setup({ "docs/a.md": "alpha" });
    await sync.sync("/repo");
    expect(memory.code_).toEqual([{ repo: "app-1a2b3c4d", dir: `/repos/app-1a2b3c4d/${C1}`, commit: C1 }]);
    expect(existsSync(join(dir, "code", "app-1a2b3c4d", C1, "main.ts"))).toBe(true);
    git.head_ = C2;
    await sync.sync("/repo");
    expect(memory.code_[1]).toMatchObject({ commit: C2, dir: `/repos/app-1a2b3c4d/${C2}` });
    expect(readdirSync(join(dir, "code", "app-1a2b3c4d"))).toEqual([C2]);
  });

  it("builds nothing twice for one commit", async () => {
    const { git, sync } = setup({});
    await sync.sync("/repo");
    await sync.sync("/repo");
    expect(git.exports).toEqual([C1]);
  });

  it("a failed ingest is a note on the repository, keeps the old folder, and is tried again", async () => {
    const memory = fakeMemory();
    const { git, sync, logs } = setup({ "docs/a.md": "alpha" }, memory);
    await sync.sync("/repo");
    git.head_ = C2;
    let fail = true;
    const ingest = memory.ingestCode;
    memory.ingestCode = async (code) => {
      if (fail) throw new Error("cognee is down");
      await ingest(code);
    };
    const report = await sync.sync("/repo");
    expect(report?.code).toBe("unchanged");
    expect(sync.health("/repo").lastFailure).toContain("cognee is down");
    expect(logs.join()).toContain("cognee is down");
    expect(readdirSync(join(dir, "code", "app-1a2b3c4d"))).toEqual([C1]);
    fail = false;
    await sync.sync("/repo");
    expect(sync.health("/repo").lastFailure).toBeNull();
    expect(readdirSync(join(dir, "code", "app-1a2b3c4d"))).toEqual([C2]);
  });

  it("a git failure never throws", async () => {
    const { git, sync } = setup({});
    git.head = async () => {
      throw new Error("no origin");
    };
    expect(await sync.sync("/repo")).toBeNull();
    expect(sync.health("/repo").lastFailure).toContain("no origin");
  });
});
