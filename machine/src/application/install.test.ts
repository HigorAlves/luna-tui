import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { sandboxExecArgs, type SandboxExec } from "../adapters/docker/docker.ts";
import { PolicyStore } from "./policy.ts";
import { type InstallDeps, configFilesChanged, ensureInstalled } from "./install.ts";

const root = mkdtempSync(join(tmpdir(), "install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function setup(over: { changed?: string[]; lockfiles?: Record<string, string>; exit?: number; modules?: boolean; scripts?: boolean; run?: "on" | "off"; dirty?: string[]; nested?: string[]; sub?: Record<string, string>; exitFor?: (argv: string[]) => number; modulesAt?: (dir: string) => boolean; changedFor?: (dirs: readonly string[]) => string[] } = {}) {
  const runs: SandboxExec[] = [];
  const asked: unknown[] = [];
  const restored: Array<[string, string[]]> = [];
  const state = { lockfiles: over.lockfiles ?? { "pnpm-lock.yaml": "blob1" }, modules: over.modules ?? true, imageId: "sha256:img" };
  const policy = new PolicyStore({ warn: () => {} });
  const deps: InstallDeps = {
    stateDir: join(root, `state-${++n}`),
    policies: { for: async () => ({ ...(await policy.for(null)), factory: { ...(await policy.for(null)).factory, sandbox: { ...(await policy.for(null)).factory.sandbox, cpu: 6, memory_gb: 12, install: { run: over.run ?? "on", scripts: over.scripts ? "on" : "off" } } } }) },
    repoImages: { ensure: async () => ({ image: "repo-image:1" }) },
    imageId: async () => state.imageId,
    lockfilesAt: async (path, commit) => (asked.push({ path, commit }), state.lockfiles),
    ...(over.sub ? { nestedLockfilesAt: async () => over.sub! } : {}),
    exec: async (run) => {
      runs.push(run);
      const code = over.exitFor ? over.exitFor(run.argv) : (over.exit ?? 0);
      return { code, stdout: "out line\n", stderr: code ? "boom: tail\n" : "" };
    },
    egress: { for: async (request) => (asked.push(request), { allow: ["registry.npmjs.org:443"], allowPrivate: [], proxyImage: "machine:dev" }) },
    yarnBerry: async () => false,
    configChanged: async (i) => (over.changedFor ? over.changedFor(i.dirs ?? []) : (over.changed ?? [])),
    hasNodeModules: async (dir) => (over.modulesAt ? over.modulesAt(dir) : state.modules),
    removeNested: () => over.nested ?? [],
    dirtyFiles: async () => over.dirty ?? [],
    restoreFiles: async (path, ref, files) => void restored.push([ref, files]),
  };
  const input = { taskId: "task-1", repoPath: "/user/repo", workspace: "/ws/repo/card-1", commit: "a".repeat(40) };
  return { deps, runs, asked, restored, state, input };
}

describe("ensureInstalled", () => {
  it("runs each step in the repository's image over the work folder, with the cache, the repository's size and the install list", async () => {
    const { deps, runs, asked, input } = setup();
    const out = await ensureInstalled(deps, input);
    expect(out.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ image: "repo-image:1", worktree: "/ws/repo/card-1", argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"], limits: { cpu: 6, memoryGb: 12 }, egress: { allow: ["registry.npmjs.org:443"], proxyImage: "machine:dev" } });
    expect(runs[0]!.cacheVolume).toBe("hardness-cache-repo");
    expect(asked).toContainEqual({ repoPath: "/user/repo", kind: "install" });
    // the lockfiles are read from the card's repository at the commit, never the folder
    expect(asked).toContainEqual({ path: "/ws/repo/card-1", commit: input.commit });
  });

  it("holds no credential, no secret and no mount of the run's input or output in its container", async () => {
    const { deps, runs, input } = setup();
    await ensureInstalled(deps, input);
    expect(Object.keys(runs[0]!)).not.toContain("secrets");
    const args = sandboxExecArgs(runs[0]!).join(" ");
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "LMNR_PROJECT_API_KEY"]) expect(args).not.toContain(name);
    for (const mount of [":/in", ":/out", ":/session", ":/graph"]) expect(args).not.toContain(mount);
  });

  it("runs nothing the second time for the same key when node_modules is there, and again when it is not or a lockfile changed", async () => {
    const { deps, runs, state, input } = setup();
    await ensureInstalled(deps, input);
    await ensureInstalled(deps, input);
    expect(runs).toHaveLength(1);
    state.modules = false;
    await ensureInstalled(deps, input);
    expect(runs).toHaveLength(2);
    state.modules = true;
    state.lockfiles = { "pnpm-lock.yaml": "blob2" };
    await ensureInstalled(deps, input);
    expect(runs).toHaveLength(3);
    state.imageId = "sha256:other";
    await ensureInstalled(deps, input);
    expect(runs).toHaveLength(4);
  });

  it("keeps its stamp outside the folder, one per workspace", async () => {
    const { deps, runs, input } = setup();
    await ensureInstalled(deps, input);
    await ensureInstalled(deps, { ...input, workspace: "/ws/repo/card-2" });
    expect(runs).toHaveLength(2);
  });

  it("runs nothing with sandbox.install.run off, and says what it skipped for a lockfile it may not install", async () => {
    const off = setup({ run: "off" });
    expect(await ensureInstalled(off.deps, off.input)).toMatchObject({ ok: true, ran: [] });
    expect(off.runs).toHaveLength(0);
    const poetry = setup({ lockfiles: { "poetry.lock": "b" }, modules: false });
    const out = await ensureInstalled(poetry.deps, poetry.input);
    expect(poetry.runs).toHaveLength(0);
    expect(out.ok && out.notes.join(" ")).toContain("sandbox.install.scripts");
  });

  it("ends as env_broken at step install, with the tool, the lockfile and the tail, when a step fails or its tool is missing", async () => {
    for (const exit of [1, 127]) {
      const { deps, input } = setup({ exit });
      const out = await ensureInstalled(deps, input);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "install", tool: "pnpm", lockfile: "pnpm-lock.yaml", logTail: expect.stringContaining("boom: tail") });
    }
  });

  it("removes a nested repository an install left and puts back a tracked file it changed, with a note each", async () => {
    const { deps, restored, input } = setup({ nested: ["node_modules/x/.git"], dirty: [" M package.json", "?? node_modules/", "M  src/a.ts"] });
    const out = await ensureInstalled(deps, input);
    expect(restored).toEqual([[input.commit, ["package.json", "src/a.ts"]]]);
    expect(out.ok && out.notes.join(" ")).toMatch(/nested.*node_modules\/x\/\.git/);
    expect(out.ok && out.notes.join(" ")).toMatch(/restored.*package\.json/);
  });
});

describe("an install with the card's own package-manager configuration", () => {
  it("is refused as env_broken at step install, in fixed words, when the card changes .npmrc, .yarnrc or .yarnrc.yml, and runs nothing", async () => {
    const { deps, runs, input } = setup({ changed: [".npmrc", ".yarnrc.yml"] });
    const out = await ensureInstalled(deps, input);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "install", reason: expect.stringContaining(".npmrc, .yarnrc.yml") });
      expect(String(out.detail.reason)).toContain("differs from the repository's own");
    }
    expect(runs).toHaveLength(0);
  });
});

describe("configFilesChanged", () => {
  const names = [".yarnrc.yml", ".yarnrc", ".npmrc"];
  const check = async (card: Record<string, string>, user: Record<string, string> | null) =>
    configFilesChanged({ cardBlobs: async () => card, userBlobs: async () => user ?? {}, baseOf: async () => (user === null ? null : "b".repeat(40)) }, { workspace: "/w", repoPath: "/r", commit: "c".repeat(40) });

  it("names the files whose blob differs from the user's checkout at the card's base, added or changed or removed", async () => {
    expect(await check({ ".npmrc": "x" }, { ".npmrc": "x" })).toEqual([]);
    expect(await check({ ".npmrc": "new" }, { ".npmrc": "old" })).toEqual([".npmrc"]);
    expect(await check({ ".yarnrc": "y" }, {})).toEqual([".yarnrc"]);
    expect(await check({}, { ".yarnrc.yml": "z" })).toEqual([".yarnrc.yml"]);
    expect(await check({}, {})).toEqual([]);
    void names;
  });

  it("fails closed when the base is unknown and the card has any of them", async () => {
    expect(await check({ ".npmrc": "x" }, null)).toEqual([".npmrc"]);
    expect(await check({}, null)).toEqual([]);
  });
});

describe("ensureInstalled: lockfiles in subfolders", () => {
  const sub = { "board/Cargo.lock": "blobC", "tools/web/package-lock.json": "blobW" };

  it("installs each subfolder's lockfile in its folder, after the root, the folder an argument and never shell text", async () => {
    const { deps, runs, input } = setup({ sub });
    const out = await ensureInstalled(deps, input);
    expect(out).toMatchObject({ ok: true, ran: ["pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile", "board: cargo fetch --locked", "tools/web: npm ci --ignore-scripts"] });
    expect(runs.map((r) => r.argv)).toEqual([
      ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"],
      ["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "install-in", "board", "cargo", "fetch", "--locked"],
      ["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "install-in", "tools/web", "npm", "ci", "--ignore-scripts"],
    ]);
  });

  it("a subfolder's failure is a note and the rest goes on; the root's still stops the install", async () => {
    const failing = setup({ sub, exitFor: (argv) => (argv.includes("cargo") ? 101 : 0) });
    const out = await ensureInstalled(failing.deps, failing.input);
    expect(out.ok).toBe(true);
    expect(out.ok && out.ran).toEqual(["pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile", "tools/web: npm ci --ignore-scripts"]);
    expect(out.ok && out.notes.join("\n")).toContain("installing from board/Cargo.lock: a check under board may fail for it");
    const root = setup({ sub, exitFor: (argv) => (argv[0] === "pnpm" ? 1 : 0) });
    expect(await ensureInstalled(root.deps, root.input)).toMatchObject({ ok: false, detail: { step: "install", lockfile: "pnpm-lock.yaml" } });
  });

  it("keys on the subfolders' lockfiles too, and installs again when a subfolder's node_modules is missing", async () => {
    let webModules = true;
    const first = setup({ sub, modulesAt: (dir) => !dir.endsWith("tools/web") || webModules });
    await ensureInstalled(first.deps, first.input);
    await ensureInstalled(first.deps, first.input);
    expect(first.runs).toHaveLength(3);
    webModules = false;
    await ensureInstalled(first.deps, first.input);
    expect(first.runs).toHaveLength(6);
  });

  it("asks about the package-manager files of every folder it installs in, and refuses one the card changed", async () => {
    let dirs: readonly string[] = [];
    const { deps, runs, input } = setup({ sub, changedFor: (d) => ((dirs = d), d.includes("tools/web") ? ["tools/web/.npmrc"] : []) });
    const out = await ensureInstalled(deps, input);
    expect(dirs).toEqual(["board", "tools/web"]);
    expect(out).toMatchObject({ ok: false, detail: { reason: expect.stringContaining("tools/web/.npmrc") } });
    expect(runs).toEqual([]);
  });
});

describe("configFilesChanged in subfolders", () => {
  it("compares each folder's files by blob, the root's first", async () => {
    const asked: string[][] = [];
    const out = await configFilesChanged(
      { cardBlobs: async (_w, _c, names) => (asked.push([...names]), { "tools/web/.npmrc": "new" }), userBlobs: async () => ({ "tools/web/.npmrc": "old" }), baseOf: async () => "b".repeat(40) },
      { workspace: "/w", repoPath: "/r", commit: "a".repeat(40), dirs: ["tools/web"] },
    );
    expect(asked[0]).toEqual([".yarnrc.yml", ".yarnrc", ".npmrc", "tools/web/.yarnrc.yml", "tools/web/.yarnrc", "tools/web/.npmrc"]);
    expect(out).toEqual(["tools/web/.npmrc"]);
  });
});
