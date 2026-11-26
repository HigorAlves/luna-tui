import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRepoCommands } from "./repo-commands.ts";

let repo: string;
const write = async (path: string, text: string) => {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "repo-commands-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("readRepoCommands", () => {
  it("reads a yarn monorepo's workspaces two folders down, its script files and its luna.yaml checks (Discover)", async () => {
    await write("package.json", JSON.stringify({ scripts: { lint: "biome check .", "test:unit": "turbo run test:unit" }, workspaces: ["apps/*", "packages/*", "!packages/skip"] }));
    await write("packages/domain/package.json", JSON.stringify({ name: "@discover/domain", scripts: { "test:unit": "vitest run", "check-types": "tsc" } }));
    await write("apps/api/package.json", JSON.stringify({ name: "@discover/api", scripts: { build: "tsc" } }));
    await write("scripts/cycle-inventory.mts", "export {}");
    await write("scripts/deploy/release.sh", "echo");
    await write("scripts/README.md", "not a script");
    const commands = await readRepoCommands(repo, ["yarn turbo run check-types"]);
    expect(commands).toEqual(expect.arrayContaining(["yarn lint", "yarn workspace @discover/domain check-types", "yarn tsx scripts/cycle-inventory.mts", "bash scripts/deploy/release.sh", "test:unit", "yarn turbo run check-types"]));
    expect(commands.some((c) => c.includes("README"))).toBe(false);
    expect(commands.some((c) => c.includes("@discover/api build"))).toBe(true);
  });

  it("reads pnpm-workspace.yaml's packages, and falls back to one folder down with no workspaces at all", async () => {
    await write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    await write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"packages/contracts\"\n");
    await write("apps/site/package.json", JSON.stringify({ name: "site", scripts: { build: "next build" } }));
    await write("packages/contracts/package.json", JSON.stringify({ name: "@hardness/contracts", scripts: { typecheck: "tsc" } }));
    expect(await readRepoCommands(repo, [])).toEqual(expect.arrayContaining(["pnpm --filter site build", "pnpm --filter @hardness/contracts typecheck"]));
    const flat = await mkdtemp(join(tmpdir(), "repo-commands-flat-"));
    await writeFile(join(flat, "package.json"), JSON.stringify({ scripts: {} }));
    await mkdir(join(flat, "web"));
    await writeFile(join(flat, "web", "package.json"), JSON.stringify({ name: "web", scripts: { build: "vite build" } }));
    expect(await readRepoCommands(flat, [])).toContain("pnpm --filter web build");
    await rm(flat, { recursive: true, force: true });
  });

  it("never follows a link out of the repo for a workspace or a script", async () => {
    await write("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    const outside = await mkdtemp(join(tmpdir(), "repo-commands-out-"));
    await writeFile(join(outside, "package.json"), JSON.stringify({ name: "evil", scripts: { deploy: "x" } }));
    await writeFile(join(outside, "steal.mts"), "export {}");
    await mkdir(join(repo, "apps"), { recursive: true });
    await symlink(outside, join(repo, "apps", "evil"));
    await mkdir(join(repo, "scripts"), { recursive: true });
    await symlink(join(outside, "steal.mts"), join(repo, "scripts", "steal.mts"));
    const commands = await readRepoCommands(repo, []);
    expect(commands.some((c) => c.includes("evil") || c.includes("steal"))).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
});
