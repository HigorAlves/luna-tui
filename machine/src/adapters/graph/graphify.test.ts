import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GraphBuildError, type GraphStamp } from "../../application/graph.ts";
import type { SandboxResult, SandboxRun } from "../docker/docker.ts";
import { graphifyGraph } from "./graphify.ts";
import { repoSlug } from "./slug.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function stampFor(commit: string): GraphStamp {
  return { schema: 1, commit, builtAt: "2026-11-04T10:00:00Z", nodes: 3, edges: 2, communities: 1, graphify: "0.9.34" };
}

function setup(exitCode = 0) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "graph-")));
  const repo = join(stateDir, "repo");
  const checkout = join(stateDir, "wt", "graph");
  mkdirSync(checkout, { recursive: true });
  const seen: SandboxRun[] = [];
  const checkouts: string[] = [];
  let head = "a".repeat(40);
  const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
    seen.push(run);
    const out = run.mounts?.find((m) => m.container === "/graph")?.host;
    if (exitCode === 0 && out) {
      mkdirSync(join(out, "graphify-out"), { recursive: true });
      writeFileSync(join(out, "graphify-out", "graph.json"), "{}");
      const commit = run.entrypoint?.at(-1) ?? "";
      writeFileSync(join(out, "stamp.json"), JSON.stringify(stampFor(commit)));
    }
    return { exitCode, timedOut: false, aborted: false, transcriptPath: "" };
  };
  const graph = graphifyGraph({
    stateDir,
    image: "img:1",
    worktreesDir: join(stateDir, "wt"),
    sandbox,
    git: {
      ensureCleanCheckout: async (_repo, path) => (checkouts.push(path), checkout),
      headCommit: async () => head,
    },
  });
  return { graph, repo, seen, checkouts, stateDir, checkout, setHead: (sha: string) => (head = sha) };
}

describe("graphifyGraph.build", () => {
  it("builds from a clean read-only checkout in the runner image and makes it current", async () => {
    const { graph, repo, seen, checkout, stateDir } = setup();
    const head = "a".repeat(40);
    const stamp = await graph.build(repo);
    expect(stamp).toEqual(stampFor(head));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      image: "img:1",
      worktree: checkout,
      writable: false,
      gitDir: null,
      credential: { env: {}, mounts: [] },
      entrypoint: ["python3", "/graph-tools/build.py", "--input", "/work", "--out", "/graph", "--commit", head],
    });
    expect(seen[0]!.mounts).toEqual([{ host: expect.stringContaining(`building-${head}`), container: "/graph", readOnly: false }]);
    const dir = graph.currentDir(repo);
    expect(dir).toBe(join(stateDir, "graphs", repoSlug(repo), head));
    expect(existsSync(join(dir!, "graphify-out", "graph.json"))).toBe(true);
    expect(await graph.stampOf(repo)).toEqual(stamp);
    expect(readdirSync(join(stateDir, "graphs", repoSlug(repo))).some((n) => n.startsWith("building-"))).toBe(false);
  });

  it("is a no-op for a commit it already has", async () => {
    const { graph, repo, seen } = setup();
    const first = await graph.build(repo);
    const second = await graph.build(repo);
    expect(second).toEqual(first);
    expect(seen).toHaveLength(1);
  });

  it("builds the next commit and repoints current", async () => {
    const { graph, repo, setHead, stateDir } = setup();
    await graph.build(repo);
    const next = "b".repeat(40);
    setHead(next);
    await graph.build(repo);
    expect((await graph.stampOf(repo))?.commit).toBe(next);
    expect(graph.currentDir(repo)).toBe(join(stateDir, "graphs", repoSlug(repo), next));
  });

  it("leaves no current and throws when the build fails", async () => {
    const { graph, repo, stateDir } = setup(2);
    await expect(graph.build(repo)).rejects.toBeInstanceOf(GraphBuildError);
    expect(graph.currentDir(repo)).toBeNull();
    expect(await graph.stampOf(repo)).toBeNull();
    const dir = join(stateDir, "graphs", repoSlug(repo));
    expect(existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("building-")) : []).toEqual([]);
  });

  it("knows nothing of a repo it never built", async () => {
    const { graph, repo } = setup();
    expect(graph.currentDir(repo)).toBeNull();
    expect(await graph.stampOf(repo)).toBeNull();
  });
});

describe("graphifyGraph.isFresh", () => {
  it("is stale only when the graph's commit is a strict ancestor of the base", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fresh-")));
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const one = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "b.txt"), "b\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const two = git(root, "rev-parse", "HEAD");
    const { graph } = setup();
    expect(await graph.isFresh(root, stampFor(one), one)).toBe(true);
    expect(await graph.isFresh(root, stampFor(one), two)).toBe(false);
    expect(await graph.isFresh(root, stampFor(two), one)).toBe(true);
    expect(await graph.isFresh(root, stampFor("c".repeat(40)), two)).toBe(true);
  });
});
