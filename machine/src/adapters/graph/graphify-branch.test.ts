import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { GraphStamp } from "../../application/graph.ts";
import type { SandboxRun } from "../docker/docker.ts";
import { graphifyGraph } from "./graphify.ts";
import { repoSlug } from "./slug.ts";

const C = (n: number) => String(n).repeat(40);
const MAIN = "a".repeat(40);
const TASK = "0f3c9a1e-aaaa-bbbb-cccc-1234567890ab";

const stampFor = (commit: string): GraphStamp => ({ schema: 1, commit, builtAt: "2026-11-04T10:00:00Z", nodes: 3, edges: 2, communities: 1, graphify: "0.9.34" });
const commitOf = (run: SandboxRun) => run.entrypoint![run.entrypoint!.indexOf("--commit") + 1]!;

/** A graph with a sandbox that writes a stamp for the commit it is given (or fails, or runs past its limit), and an export that only records. */
function make(opts: { exit?: number; timedOut?: boolean; hold?: Promise<void>; withMain?: boolean } = {}) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "graph-branch-")));
  const repo = join(stateDir, "repo");
  const runs: SandboxRun[] = [];
  const exported: Array<{ workspace: string; commit: string; dest: string }> = [];
  const graph = graphifyGraph({
    stateDir,
    image: "img:1",
    worktreesDir: join(stateDir, "wt"),
    sandbox: async (run) => {
      runs.push(run);
      await opts.hold;
      const out = run.mounts!.find((m) => m.container === "/graph")!.host;
      if (!opts.exit && !opts.timedOut) {
        mkdirSync(join(out, "graphify-out"), { recursive: true });
        writeFileSync(join(out, "graphify-out", "graph.json"), "{}");
        mkdirSync(join(out, "graphify-out", "cache"), { recursive: true });
        writeFileSync(join(out, "stamp.json"), JSON.stringify(stampFor(commitOf(run))));
      }
      return { exitCode: opts.exit ?? 0, timedOut: opts.timedOut ?? false, aborted: false, transcriptPath: "" };
    },
    git: {
      ensureCleanCheckout: async (_repo, path) => path,
      headCommit: async () => MAIN,
      exportCommit: async (workspace, commit, dest) => {
        exported.push({ workspace, commit, dest });
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, "marker.txt"), commit);
      },
    },
  });
  const repoDir = join(stateDir, "graphs", repoSlug(repo));
  if (opts.withMain !== false) {
    mkdirSync(join(repoDir, MAIN, "graphify-out"), { recursive: true });
    writeFileSync(join(repoDir, MAIN, "stamp.json"), JSON.stringify(stampFor(MAIN)));
    symlinkSync(MAIN, join(repoDir, "current"));
  }
  const cardDir = join(repoDir, "cards", TASK);
  const input = (commit: string, over: Record<string, unknown> = {}) => ({ repoPath: repo, taskId: TASK, workspacePath: "/ws/card", commit, minutes: 3, ...over });
  return { graph, repo, stateDir, runs, exported, repoDir, cardDir, input };
}

describe("graphifyGraph branch graphs", () => {
  it("builds the graph of a slice commit from an export of that commit, in a sandbox with no network, under cards/<task>/<commit>/", async () => {
    const w = make();
    expect(await w.graph.buildBranch!(w.input(C(1)))).toMatchObject({ state: "built", mode: "full" });
    // The commit comes out of the card's own repository through its workspace path (the host-git helpers pin M); the folder is never read.
    expect(w.exported).toEqual([{ workspace: "/ws/card", commit: C(1), dest: expect.stringContaining(repoSlug(w.repo)) }]);
    expect(w.runs[0]).toMatchObject({ image: "img:1", writable: false, gitDir: null, networkNone: true, timeoutMs: 3 * 60_000, credential: { env: {}, mounts: [] }, worktree: w.exported[0]!.dest });
    expect(w.runs[0]!.entrypoint).toEqual(expect.arrayContaining(["/opt/luna/graph-tools/build.py", "--commit", C(1), "--keep-cache"]));
    const found = await w.graph.branchGraph!(w.repo, TASK);
    expect(found?.dir).toBe(join(w.cardDir, C(1)));
    expect(found?.stamp.commit).toBe(C(1));
    expect(existsSync(w.exported[0]!.dest)).toBe(false);
  });

  it("builds incrementally from the previous commit's graph: its folder is mounted read-only and its cache seeded", async () => {
    const w = make();
    await w.graph.buildBranch!(w.input(C(1)));
    expect(w.runs[0]!.entrypoint).not.toContain("--seed-cache");
    expect(await w.graph.buildBranch!(w.input(C(2)))).toMatchObject({ state: "built", mode: "incremental" });
    expect(w.runs[1]!.mounts).toContainEqual({ host: join(w.cardDir, C(1)), container: "/graph-prev", readOnly: true });
    expect(w.runs[1]!.entrypoint).toEqual(expect.arrayContaining(["--seed-cache", "/graph-prev"]));
    expect((await w.graph.branchGraph!(w.repo, TASK))?.stamp.commit).toBe(C(2));
  });

  it("keeps the previous commit's folder beside the newest and prunes the older ones", async () => {
    const w = make();
    for (const n of [1, 2, 3, 4]) await w.graph.buildBranch!(w.input(C(n)));
    expect(readdirSync(w.cardDir).filter((n) => /^[0-9a-f]{40}$/.test(n)).sort()).toEqual([C(2), C(3), C(4)]);
  });

  it("does nothing without a main graph, and refuses a task id or a commit that is not plain", async () => {
    const none = make({ withMain: false });
    expect(await none.graph.buildBranch!(none.input(C(1)))).toMatchObject({ state: "skipped" });
    expect(none.exported).toEqual([]);
    const w = make();
    expect(await w.graph.buildBranch!(w.input("main"))).toMatchObject({ state: "failed" });
    expect(await w.graph.buildBranch!(w.input(C(1), { taskId: "../x" }))).toMatchObject({ state: "failed" });
    expect(w.runs).toEqual([]);
  });

  it("fails with the reason and builds nothing when the build exits badly or runs past its limit", async () => {
    const bad = make({ exit: 1 });
    expect(await bad.graph.buildBranch!(bad.input(C(1)))).toMatchObject({ state: "failed", reason: expect.stringContaining("exit code 1") });
    const slow = make({ timedOut: true });
    expect(await slow.graph.buildBranch!(slow.input(C(1), { minutes: 3 }))).toMatchObject({ state: "failed", reason: expect.stringContaining("3 minutes") });
    expect(await slow.graph.branchGraph!(slow.repo, TASK)).toBeNull();
    expect(readdirSync(slow.cardDir).some((n) => n.startsWith("building-"))).toBe(false);
  });

  it("leaves the previous branch graph in place when a later build fails", async () => {
    const w = make();
    await w.graph.buildBranch!(w.input(C(1)));
    const failing = graphifyGraph({
      stateDir: w.stateDir,
      image: "img:1",
      worktreesDir: join(w.stateDir, "wt"),
      sandbox: async () => ({ exitCode: 1, timedOut: false, aborted: false, transcriptPath: "" }),
      git: { ensureCleanCheckout: async (_r, p) => p, headCommit: async () => MAIN, exportCommit: async (_w, _c, dest) => void mkdirSync(dest, { recursive: true }) },
    });
    expect(await failing.buildBranch!(w.input(C(2)))).toMatchObject({ state: "failed" });
    expect((await failing.branchGraph!(w.repo, TASK))?.stamp.commit).toBe(C(1));
  });

  it("builds only the newest of the commits that queue up for one card", async () => {
    let release!: () => void;
    const w = make({ hold: new Promise<void>((r) => (release = r)) });
    const first = w.graph.buildBranch!(w.input(C(1)));
    await new Promise((r) => setTimeout(r, 20));
    const second = w.graph.buildBranch!(w.input(C(2)));
    const third = w.graph.buildBranch!(w.input(C(3)));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await Promise.all([first, second, third])).map((r) => r.state)).toEqual(["built", "skipped", "built"]);
    expect(w.runs.map(commitOf)).toEqual([C(1), C(3)]);
  });

  it("drops a card's graphs on close, and a build that finishes after that leaves nothing behind", async () => {
    const w = make();
    await w.graph.buildBranch!(w.input(C(1)));
    await w.graph.dropBranch!(w.repo, TASK);
    expect(existsSync(w.cardDir)).toBe(false);
    expect(await w.graph.branchGraph!(w.repo, TASK)).toBeNull();

    let release!: () => void;
    const late = make({ hold: new Promise<void>((r) => (release = r)) });
    const running = late.graph.buildBranch!(late.input(C(1)));
    await new Promise((r) => setTimeout(r, 20));
    await late.graph.dropBranch!(late.repo, TASK);
    release();
    expect((await running).state).toBe("skipped");
    expect(await late.graph.branchGraph!(late.repo, TASK)).toBeNull();
    expect(existsSync(late.cardDir)).toBe(false);
  });
});
