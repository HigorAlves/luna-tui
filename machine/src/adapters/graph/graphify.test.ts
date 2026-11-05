import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function setup(exitCode = 0, extra: Partial<Parameters<typeof graphifyGraph>[0]> = {}) {
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
    ...extra,
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
      entrypoint: ["/opt/luna/python/bin/python3", "/opt/luna/graph-tools/build.py", "--input", "/work", "--out", "/graph", "--commit", head],
    });
    expect(seen[0]!.mounts).toEqual([{ host: expect.stringContaining(`building-${head}`), container: "/graph", readOnly: false }]);
    const dir = graph.currentDir(repo);
    expect(dir).toBe(join(stateDir, "graphs", repoSlug(repo), head));
    expect(existsSync(join(dir!, "graphify-out", "graph.json"))).toBe(true);
    expect(await graph.stampOf(repo)).toEqual(stamp);
    expect(readdirSync(join(stateDir, "graphs", repoSlug(repo))).some((n) => n.startsWith("building-"))).toBe(false);
  });

  it("mounts the repo's misses file read-only and hands it to the build, only when there is one", async () => {
    const first = setup();
    await first.graph.build(first.repo);
    expect(first.seen[0]!.mounts).toHaveLength(1);
    expect(first.seen[0]!.entrypoint).not.toContain("--misses");

    const { graph, repo, seen, stateDir, setHead } = setup();
    setHead("b".repeat(40));
    await graph.recordMisses(repo, { task: "t1", at: "2026-11-04T10:00:00Z", files: ["a.ts"] });
    await graph.build(repo);
    expect(seen[0]!.mounts).toContainEqual({ host: join(stateDir, "graphs", repoSlug(repo), "misses.jsonl"), container: "/graph-misses.jsonl", readOnly: true });
    expect(seen[0]!.entrypoint!.slice(-2)).toEqual(["--misses", "/graph-misses.jsonl"]);
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

  it("keeps the three newest graphs, so a stage that mounted an older one is not pulled out from under", async () => {
    const { graph, repo, setHead, stateDir } = setup();
    for (const sha of ["a", "b", "c", "d"]) {
      setHead(sha.repeat(40));
      await graph.build(repo);
    }
    const kept = readdirSync(join(stateDir, "graphs", repoSlug(repo))).filter((n) => /^[0-9a-f]{40}$/.test(n)).sort();
    expect(kept).toEqual(["b".repeat(40), "c".repeat(40), "d".repeat(40)]);
  });

  it("gives the build container no network and the slug-keyed checkout", async () => {
    const { graph, repo, seen, checkouts, stateDir } = setup();
    await graph.build(repo);
    expect(seen[0]!.networkNone).toBe(true);
    expect(checkouts[0]).toBe(join(stateDir, "wt", repoSlug(repo), "graph"));
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

describe("a graph and the image that builds it", () => {
  it("is built in the repository's own image, and the stamp records the image's id", async () => {
    const { graph, repo, seen } = setup(0, { image: async (repoPath) => (repoPath === "/shop" ? "hardness-runner-shop:1" : "img:1"), imageId: async (image) => `sha256:id-of-${image}` });
    const stamp = await graph.build("/shop");
    expect(seen[0]?.image).toBe("hardness-runner-shop:1");
    expect(stamp.image).toBe("sha256:id-of-hardness-runner-shop:1");
    expect((await graph.stampOf("/shop"))?.image).toBe("sha256:id-of-hardness-runner-shop:1");
    expect(repo).toBeTruthy();
  });

  it("is stale whatever its commit when the image's Graphify is another version, and is rebuilt before use", async () => {
    let version = "0.9.34";
    const { graph, repo, seen } = setup(0, { graphifyVersion: async () => version });
    const first = await graph.build(repo);
    expect(await graph.isFresh(repo, first, first.commit)).toBe(true);
    await graph.build(repo);
    expect(seen).toHaveLength(1);
    version = "0.10.0";
    expect(await graph.isFresh(repo, first, first.commit)).toBe(false);
    await graph.build(repo);
    expect(seen).toHaveLength(2);
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

describe("graphifyGraph.pastMisses", () => {
  it("lists the files accepted outside the map, most frequent first, at most twenty, plain repository paths only", async () => {
    const { graph, repo } = setup();
    await graph.recordMisses(repo, { task: "t1", at: "2026-11-04T10:00:00Z", files: ["b.ts", "a.ts", "../escape", "/abs", "c d\ne", "src/x.ts"] });
    await graph.recordMisses(repo, { task: "t2", at: "2026-11-04T11:00:00Z", files: ["a.ts", "src/x.ts", "a.ts"] });
    await graph.recordMisses(repo, { task: "t3", at: "2026-11-04T12:00:00Z", files: ["a.ts"] });
    expect(await graph.pastMisses!(repo)).toEqual(["a.ts", "src/x.ts", "b.ts"]);
    for (let i = 0; i < 30; i++) await graph.recordMisses(repo, { task: `n${i}`, at: "t", files: [`f${i}.ts`] });
    expect((await graph.pastMisses!(repo)).length).toBe(20);
  });

  it("is empty for a repository with no misses file", async () => {
    const { graph, repo } = setup();
    expect(await graph.pastMisses!(repo)).toEqual([]);
  });
});

describe("graphifyGraph.recordMisses", () => {
  it("appends one JSON line per call to graphs/<slug>/misses.jsonl", async () => {
    const { graph, repo, stateDir } = setup();
    await graph.recordMisses(repo, { task: "t1", at: "2026-11-04T10:00:00Z", files: ["a.ts"] });
    await graph.recordMisses(repo, { task: "t2", at: "2026-11-04T11:00:00Z", files: ["b.ts", "c.ts"] });
    const lines = readFileSync(join(stateDir, "graphs", repoSlug(repo), "misses.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { task: "t1", at: "2026-11-04T10:00:00Z", files: ["a.ts"] },
      { task: "t2", at: "2026-11-04T11:00:00Z", files: ["b.ts", "c.ts"] },
    ]);
  });
});

describe("graphifyGraph.locate and impact", () => {
  const coupon = { id: "coupon", label: "applyCoupon", source_file: "src/cart/coupon.ts", community: 1 };
  const graphJson = {
    nodes: [coupon, { id: "total", label: "cartTotal", source_file: "src/cart/total.ts", community: 1 }, { id: "couponTest", label: "couponTest", source_file: "src/cart/coupon.test.ts", community: 1 }],
    links: [{ source: "total", target: "coupon" }, { source: "couponTest", target: "coupon" }],
  };

  async function built(options: { behind?: number | null; codeowners?: string | null; graph?: unknown } = {}) {
    const ctx = setup();
    const withGit = graphifyGraph({
      stateDir: ctx.stateDir,
      image: "img:1",
      worktreesDir: join(ctx.stateDir, "wt"),
      sandbox: async (run) => {
        const out = run.mounts?.find((m) => m.container === "/graph")?.host ?? "";
        mkdirSync(join(out, "graphify-out"), { recursive: true });
        writeFileSync(join(out, "graphify-out", "graph.json"), JSON.stringify(options.graph ?? graphJson));
        writeFileSync(join(out, "stamp.json"), JSON.stringify(stampFor(run.entrypoint?.at(-1) ?? "")));
        return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
      },
      git: {
        ensureCleanCheckout: async () => ctx.checkout,
        headCommit: async () => "a".repeat(40),
        commitsBehind: async () => options.behind ?? 0,
        codeowners: async () => (options.codeowners === undefined ? "src/cart/ @acme/cart\n" : options.codeowners),
      },
    });
    await withGit.build(ctx.repo);
    return { ...ctx, graph: withGit };
  }

  it("ranks the file a text points at, with its owners and component", async () => {
    const { graph, repo } = await built();
    const found = await graph.locate(repo, "applyCoupon charges twice");
    expect(found).toMatchObject({ files: ["src/cart/coupon.ts", "src/cart/coupon.test.ts"], symbols: ["applyCoupon", "couponTest"], components: ["1"], owners: [{ path: "src/cart/coupon.ts", owners: ["@acme/cart"] }, { path: "src/cart/coupon.test.ts", owners: ["@acme/cart"] }], codeowners: true, stale: false, behind: 0 });
    expect(found!.confidence).toBeGreaterThan(0);
  });

  it("is stale beyond 50 commits behind and not at 50, keeping the count; the repo's bar wins", async () => {
    const at50 = await built({ behind: 50 });
    expect(await at50.graph.locate(at50.repo, "applyCoupon")).toMatchObject({ stale: false, behind: 50 });
    const at51 = await built({ behind: 51 });
    expect(await at51.graph.locate(at51.repo, "applyCoupon")).toMatchObject({ stale: true, behind: 51 });
    expect(await at51.graph.locate(at51.repo, "applyCoupon", { staleCommits: 100 })).toMatchObject({ stale: false, behind: 51 });
  });

  it("has no owners when the repo has no CODEOWNERS, and no answer when the repo has no graph", async () => {
    const { graph, repo } = await built({ codeowners: null });
    expect(await graph.locate(repo, "applyCoupon")).toMatchObject({ owners: [], codeowners: false });
    const none = setup();
    expect(await none.graph.locate(none.repo, "applyCoupon")).toBeNull();
    expect(await none.graph.impact(none.repo, ["src/cart/coupon.ts"])).toBeNull();
  });

  it("names who owns the paths it is given, whether or not the graph knows those files, and says when there is no CODEOWNERS or no graph", async () => {
    const { graph, repo } = await built({ codeowners: "src/cart/ @acme/cart\ndocs/ @acme/docs\n" });
    expect(await graph.owners(repo, ["src/cart/new.ts", "docs/a.md", "src/other.ts"])).toEqual({ owners: [{ path: "src/cart/new.ts", owners: ["@acme/cart"] }, { path: "docs/a.md", owners: ["@acme/docs"] }], codeowners: true });
    const bare = await built({ codeowners: null });
    expect(await bare.graph.owners(bare.repo, ["src/cart/new.ts"])).toEqual({ owners: [], codeowners: false });
    const none = setup();
    expect(await none.graph.owners(none.repo, ["a.ts"])).toBeNull();
    // Only plain repo paths are asked about: a glob or a parent path names nothing.
    expect(await graph.owners(repo, ["**", "../x", "/etc/passwd", "src/*"])).toEqual({ owners: [], codeowners: true, dropped: 4 });
    // Brackets and parentheses are ordinary in a real path: looked up, not dropped. A path it dropped is counted, never read as owner-free.
    const next = await built({ codeowners: "app/ @acme/web\n" });
    expect(await next.graph.owners(next.repo, ["app/[team]/page.tsx", "app/(shop)/cart.tsx", "x/*"])).toEqual({ owners: [{ path: "app/[team]/page.tsx", owners: ["@acme/web"] }, { path: "app/(shop)/cart.tsx", owners: ["@acme/web"] }], codeowners: true, dropped: 1 });
  });

  it("answers impact from the current graph: importers and tests", async () => {
    const { graph, repo } = await built();
    expect(await graph.impact(repo, ["src/cart/coupon.ts"])).toEqual({ importers: ["src/cart/coupon.test.ts", "src/cart/total.ts"], dependents: [], tests: ["src/cart/coupon.test.ts"] });
  });

  it("reads nothing from a graph file that is a symlink out of its folder", async () => {
    const { graph, repo, stateDir } = await built();
    const dir = graph.currentDir(repo)!;
    writeFileSync(join(stateDir, "elsewhere.json"), JSON.stringify(graphJson));
    rmSync(join(dir, "graphify-out", "graph.json"));
    symlinkSync(join(stateDir, "elsewhere.json"), join(dir, "graphify-out", "graph.json"));
    expect(await graph.locate(repo, "applyCoupon")).toBeNull();
  });
});
