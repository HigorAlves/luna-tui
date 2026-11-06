import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { sandboxExecArgs, type SandboxExec } from "../adapters/docker/docker.ts";
import { PolicyStore } from "./policy.ts";
import { type InstallDeps, ensureInstalled } from "./install.ts";

const root = mkdtempSync(join(tmpdir(), "install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function setup(over: { lockfiles?: Record<string, string>; exit?: number; modules?: boolean; scripts?: boolean; run?: "on" | "off"; dirty?: string[]; nested?: string[] } = {}) {
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
    exec: async (run) => (runs.push(run), { code: over.exit ?? 0, stdout: "out line\n", stderr: over.exit ? "boom: tail\n" : "" }),
    egress: { for: async (request) => (asked.push(request), { allow: ["registry.npmjs.org:443"], allowPrivate: [], proxyImage: "machine:dev" }) },
    yarnBerry: async () => false,
    hasNodeModules: async () => state.modules,
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
    expect(runs[0]).toMatchObject({ image: "repo-image:1", worktree: "/ws/repo/card-1", argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], limits: { cpu: 6, memoryGb: 12 }, egress: { allow: ["registry.npmjs.org:443"], proxyImage: "machine:dev" } });
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
