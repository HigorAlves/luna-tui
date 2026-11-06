// The Graphify adapter of the Graph port. A graph lives at
// `<stateDir>/graphs/<repo-slug>/<commit>/` (`graphify-out/graph.json`, the report, `stamp.json`)
// with a `current` symlink to the newest. A build is a sandbox job on the runner image with the
// entrypoint overridden to `/graph-tools/build.py`, over a clean checkout of the default branch
// mounted read-only; no model, no credential.
import { existsSync, readlinkSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";

import { readRegularFile } from "../fs/bounded.ts";
import { join, sep } from "node:path";

import { FACTORY_DEFAULTS, isPlainRepoPath } from "@hardness/contracts";

import { type BranchBuild, type BranchBuildInput, type BranchGraph, GraphBuildError, type Graph, type GraphStamp } from "../../application/graph.ts";
import type { GraphJson } from "../../domain/blast-radius.ts";
import { parseCodeowners, requiredOwners } from "../../domain/codeowners.ts";
import { impact } from "../../domain/graph-impact.ts";
import { type LocateGraph, locate } from "../../domain/graph-locate.ts";
import type { SandboxResult, SandboxRun } from "../docker/docker.ts";
import { checkoutHead, commitsBehind, defaultBranchFile, ensureCleanCheckout, exportCommit, graphCheckoutPath, isAncestor } from "../git/worktree.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { repoSlug } from "./slug.ts";

/** Where a repo's misses file is mounted in the build container. */
const MISSES_MOUNT = "/graph-misses.jsonl";
/** The misses file is the machine's own, but a card declares what goes in it: it is read only up to this size, and at most this many paths seed a shortlist. */
const MAX_STAMP_BYTES = 64 * 1024;
const MAX_MISSES_BYTES = 2 * 1024 * 1024;
export const MAX_PAST_MISSES = 20;
const BUILD_TIMEOUT_MS = 15 * 60_000;
/** Commit folders kept per repo: the current graph and two older ones a running stage may still mount. */
export const KEEP_GRAPHS = 3;
/** Commit folders kept per card: the newest and the ones before it that a run may still have mounted. */
export const KEEP_BRANCH_GRAPHS = 3;
/** Where the previous branch graph is mounted in a branch build, for the incremental update. */
const PREVIOUS_MOUNT = "/graph-prev";
const TASK_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface GraphGit {
  ensureCleanCheckout(repoPath: string, path: string): Promise<string>;
  /** HEAD of the read-only checkout `ensureCleanCheckout` made, read from the repository that registered it. */
  headCommit(path: string, repoPath: string): Promise<string>;
  /** Writes the files of `commit` from the card's machine-owned repository (named by its workspace path) into the new folder `dest`. Default: `exportCommit`. */
  exportCommit?(workspacePath: string, commit: string, dest: string): Promise<void>;
  /** Commits the default branch has over `commit`; null when unknown. Default: the repo's last-known default branch. */
  commitsBehind?(repoPath: string, commit: string): Promise<number | null>;
  /** The repo's CODEOWNERS text at the default branch; null when it has none. */
  codeowners?(repoPath: string): Promise<string | null>;
}

/** A graph file bigger than this is not read: it is the machine's own build output, but a corrupt one must not fill memory. */
export const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** `graphify-out/graph.json` of a graph folder: a regular file inside it (no symlink out), at most `MAX_GRAPH_BYTES`; null otherwise. */
async function readGraphJson(dir: string): Promise<(GraphJson & LocateGraph) | null> {
  try {
    const file = join(dir, "graphify-out", "graph.json");
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_GRAPH_BYTES) return null;
    const [root, real] = await Promise.all([realpath(dir), realpath(file)]);
    if (!real.startsWith(root + sep)) return null;
    return JSON.parse(await readFile(file, "utf8")) as GraphJson & LocateGraph;
  } catch {
    return null;
  }
}

export interface GraphifyDeps {
  stateDir: string;
  /** The image a build runs in: one for every repository, or the repository's own (`RepoImages`). */
  image: string | ((repoPath: string, signal?: AbortSignal) => Promise<string>);
  /** The id of a local image, written into the stamp; absent, the stamp carries none. */
  imageId?: (image: string) => Promise<string>;
  /** The Graphify version the repository's image carries now; a stamp built by another version is stale. Absent, no version is compared. */
  graphifyVersion?: () => Promise<string | null>;
  worktreesDir: string;
  sandbox: (run: SandboxRun) => Promise<SandboxResult>;
  git?: GraphGit;
}

/** Replaces `stamp.json` without following whatever the build left there: the entry is removed, then created exclusively and without following a link. */
async function writeStamp(path: string, text: string): Promise<void> {
  await rm(path, { force: true });
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

export function graphifyGraph(deps: GraphifyDeps): Graph {
  const git: GraphGit = deps.git ?? { ensureCleanCheckout, headCommit: (path, repoPath) => checkoutHead(repoPath, path) };
  const behindOf = git.commitsBehind ?? commitsBehind;
  const ownersText = git.codeowners ?? ((repoPath: string) => defaultBranchFile(repoPath, CODEOWNERS_PATHS));
  const dirOf = (repoPath: string) => join(deps.stateDir, "graphs", repoSlug(repoPath));

  async function readStamp(dir: string): Promise<GraphStamp | null> {
    try {
      // Written by a build that ran in the repository's image: read only a regular file (never a link out of the folder), within a cap.
      const stamp = JSON.parse(await readRegularFile(join(dir, "stamp.json"), MAX_STAMP_BYTES)) as GraphStamp;
      return typeof stamp?.commit === "string" ? stamp : null;
    } catch {
      return null;
    }
  }

  function current(repoPath: string): string | null {
    try {
      return join(dirOf(repoPath), readlinkSync(join(dirOf(repoPath), "current")));
    } catch {
      return null;
    }
  }

  async function point(repoDir: string, commit: string): Promise<void> {
    const tmp = join(repoDir, "current.tmp");
    await rm(tmp, { force: true });
    await symlink(commit, tmp);
    await rename(tmp, join(repoDir, "current"));
  }

  /** Drops every commit folder but the `KEEP_GRAPHS` newest: a stage that mounted an older graph may run for a
   *  long time, and the default branch can move more than once meanwhile. */
  async function prune(repoDir: string): Promise<void> {
    const commits = (await readdir(repoDir).catch(() => [])).filter((name) => /^[0-9a-f]{40}$/.test(name));
    const newestFirst = commits.map((name) => ({ name, at: statSync(join(repoDir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const { name } of newestFirst.slice(KEEP_GRAPHS)) await rm(join(repoDir, name), { recursive: true, force: true });
  }

  // ---- Branch graphs: the graph of a card's newest accepted slice commit, `<graphs>/<repo>/cards/<task>/<commit>/`.
  const exportOf = git.exportCommit ?? exportCommit;
  const cardDirOf = (repoPath: string, taskId: string) => join(dirOf(repoPath), "cards", taskId);
  /** The newest commit asked for per card: a build that starts for an older one is skipped. */
  const wanted = new Map<string, string>();
  /** Each card's builds run one after another. */
  const chains = new Map<string, Promise<unknown>>();
  /** Raised when a card's graphs are dropped: a build that started before that discards its output. */
  const epochs = new Map<string, number>();
  const keyOf = (repoPath: string, taskId: string) => `${repoPath}\0${taskId}`;

  function branchCurrent(repoPath: string, taskId: string): string | null {
    try {
      return join(cardDirOf(repoPath, taskId), readlinkSync(join(cardDirOf(repoPath, taskId), "current")));
    } catch {
      return null;
    }
  }

  async function pruneBranch(cardDir: string): Promise<void> {
    const commits = (await readdir(cardDir).catch(() => [])).filter((name) => COMMIT.test(name));
    const newestFirst = commits
      .flatMap((name) => {
        try {
          return [{ name, at: statSync(join(cardDir, name)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at - a.at);
    for (const { name } of newestFirst.slice(KEEP_BRANCH_GRAPHS)) await rm(join(cardDir, name), { recursive: true, force: true });
  }

  async function branchNow(input: BranchBuildInput, epoch: number): Promise<BranchBuild> {
    const { repoPath, taskId, commit } = input;
    const key = keyOf(repoPath, taskId);
    if (wanted.get(key) !== commit) return { state: "skipped", reason: "a newer commit of the card is waiting for its graph" };
    if (!current(repoPath)) return { state: "skipped", reason: "the repository has no main graph" };
    const cardDir = cardDirOf(repoPath, taskId);
    const slug = repoSlug(repoPath);
    const checkout = join(deps.worktreesDir, slug, `branch-${taskId}`);
    const building = join(cardDir, `building-${commit}`);
    const discard = async () => {
      await rm(building, { recursive: true, force: true });
      await rm(checkout, { recursive: true, force: true });
    };
    try {
      let image: string;
      let imageName: string | null = null;
      try {
        image = typeof deps.image === "function" ? await deps.image(repoPath) : deps.image;
        imageName = deps.imageId ? await deps.imageId(image) : null;
      } catch (error) {
        return { state: "failed", reason: `the graph build did not run: ${(error as Error).message}` };
      }
      const target = join(cardDir, commit);
      const have = await readStamp(target);
      const expected = (await deps.graphifyVersion?.().catch(() => null)) ?? null;
      if (have && (expected === null || have.graphify === expected) && (imageName === null || have.image === imageName)) {
        if (branchCurrent(repoPath, taskId) !== target) await point(cardDir, commit);
        return { state: "built", stamp: have, mode: "full" };
      }
      // The previous commit's graph, when this Graphify in this image built it: its cache makes the build incremental.
      const previous = branchCurrent(repoPath, taskId);
      const before = previous ? await readStamp(previous) : null;
      const usable =
        previous && before && previous !== target && (expected === null || before.graphify === expected) && (imageName === null || before.image === imageName) && existsSync(join(previous, "graphify-out", "cache"))
          ? previous
          : null;
      await mkdir(cardDir, { recursive: true });
      await rm(building, { recursive: true, force: true });
      await mkdir(building, { recursive: true });
      try {
        await exportOf(input.workspacePath, commit, checkout);
      } catch (error) {
        await discard();
        return { state: "failed", reason: `the commit could not be exported from the card's repository: ${safe((error as Error).message).slice(0, 300)}` };
      }
      let result: SandboxResult;
      try {
        result = await deps.sandbox({
          name: `luna-graph-branch-${slug}-${taskId.slice(0, 8)}`,
          image,
          runDir: join(dirOf(repoPath), "run"),
          worktree: checkout,
          writable: false,
          gitDir: null,
          input: {},
          timeoutMs: input.minutes * 60_000,
          credential: { env: {}, mounts: [] },
          labels: { luna: "graph-branch", "luna.repo": slug },
          mounts: [{ host: building, container: "/graph", readOnly: false }, ...(usable ? [{ host: usable, container: PREVIOUS_MOUNT, readOnly: true }] : [])],
          entrypoint: ["/opt/luna/python/bin/python3", "/opt/luna/graph-tools/build.py", "--input", "/work", "--out", "/graph", "--commit", commit, "--keep-cache", ...(usable ? ["--seed-cache", PREVIOUS_MOUNT] : [])],
          networkNone: true,
        });
      } catch (error) {
        await discard();
        return { state: "failed", reason: `the graph build did not run: ${safe((error as Error).message).slice(0, 300)}` };
      }
      let stamp = result.exitCode === 0 ? await readStamp(building) : null;
      if (stamp && imageName !== null) {
        stamp = { ...stamp, image: imageName };
        await writeStamp(join(building, "stamp.json"), JSON.stringify(stamp, null, 2));
      }
      if (!stamp) {
        await discard();
        const why = result.timedOut ? `ran past ${input.minutes} minutes` : result.aborted ? "aborted" : `exit code ${result.exitCode}`;
        return { state: "failed", reason: `the graph build of ${commit.slice(0, 7)} failed (${why})` };
      }
      // The card was closed or removed while the build ran: nothing of it stays.
      if ((epochs.get(key) ?? 0) !== epoch) {
        await discard();
        await rm(cardDir, { recursive: true, force: true });
        return { state: "skipped", reason: "the card's graphs were dropped while the build ran" };
      }
      await rm(checkout, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
      await rename(building, target);
      await point(cardDir, commit);
      await pruneBranch(cardDir);
      return { state: "built", stamp, mode: usable ? "incremental" : "full" };
    } catch (error) {
      await discard().catch(() => {});
      return { state: "failed", reason: safe(error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }

  const inflight = new Map<string, Promise<GraphStamp>>();
  /** The last failure of each repository's build, flattened and capped, whoever asked for the build; a success clears it. */
  const failures = new Map<string, string>();

  async function buildNow(repoPath: string, signal?: AbortSignal): Promise<GraphStamp> {
    const repoDir = dirOf(repoPath);
    const checkout = await git.ensureCleanCheckout(repoPath, graphCheckoutPath(repoSlug(repoPath), deps.worktreesDir));
    const commit = await git.headCommit(checkout, repoPath);
    const target = join(repoDir, commit);
    // The image is chosen once: the sandbox runs in it, the stamp names it, and the cache check below compares it.
    let image: string;
    let imageName: string | null = null;
    try {
      image = typeof deps.image === "function" ? await deps.image(repoPath, signal) : deps.image;
      imageName = deps.imageId ? await deps.imageId(image) : null;
    } catch (error) {
      throw new GraphBuildError(`the graph build did not run: ${(error as Error).message}`);
    }
    const have = await readStamp(target);
    const expected = (await deps.graphifyVersion?.().catch(() => null)) ?? null;
    if (have && (expected === null || have.graphify === expected) && (imageName === null || have.image === imageName)) {
      const previous = current(repoPath);
      if (previous !== target) await point(repoDir, commit);
      return have;
    }
    // The files scope checks found outside the code map: the build counts them into the stamp.
    const missesFile = join(repoDir, "misses.jsonl");
    const hasMisses = existsSync(missesFile);
    const building = join(repoDir, `building-${commit}`);
    await rm(building, { recursive: true, force: true });
    await mkdir(building, { recursive: true });
    let result: SandboxResult;
    try {
      result = await deps.sandbox({
        name: `luna-graph-${repoSlug(repoPath)}`,
        image,
        runDir: join(repoDir, "run"),
        worktree: checkout,
        writable: false,
        gitDir: null,
        input: {},
        timeoutMs: BUILD_TIMEOUT_MS,
        credential: { env: {}, mounts: [] },
        labels: { luna: "graph", "luna.repo": repoSlug(repoPath) },
        mounts: [{ host: building, container: "/graph", readOnly: false }, ...(hasMisses ? [{ host: missesFile, container: MISSES_MOUNT, readOnly: true }] : [])],
        entrypoint: ["/opt/luna/python/bin/python3", "/opt/luna/graph-tools/build.py", "--input", "/work", "--out", "/graph", "--commit", commit, ...(hasMisses ? ["--misses", MISSES_MOUNT] : [])],
        // Parsing untrusted code needs no network at all.
        networkNone: true,
        signal,
      });
    } catch (error) {
      await rm(building, { recursive: true, force: true });
      throw new GraphBuildError(`the graph build did not run: ${(error as Error).message}`);
    }
    let stamp = result.exitCode === 0 ? await readStamp(building) : null;
    // The image the graph was built in, by its id: the machine records it, the container cannot.
    if (stamp && imageName !== null) {
      stamp = { ...stamp, image: imageName };
      await writeStamp(join(building, "stamp.json"), JSON.stringify(stamp, null, 2));
    }
    if (!stamp) {
      await rm(building, { recursive: true, force: true });
      const why = result.timedOut ? "timed out" : result.aborted ? "aborted" : `exit code ${result.exitCode}`;
      throw new GraphBuildError(`the graph build of ${commit.slice(0, 7)} failed (${why})`);
    }
    await rm(target, { recursive: true, force: true });
    await rename(building, target);
    await point(repoDir, commit);
    await prune(repoDir);
    return stamp;
  }

  return {
    async stampOf(repoPath) {
      const dir = current(repoPath);
      return dir ? readStamp(dir) : null;
    },

    currentDir(repoPath) {
      return current(repoPath);
    },

    // One build in flight per repository, whoever asks (the watch, a card waiting for its graph, a rebuild on merge): two at once
    // would remove each other's output folder and collide on the container's name. The first caller's signal is the build's.
    build(repoPath, signal) {
      const running = inflight.get(repoPath);
      if (running) return running;
      const entry = buildNow(repoPath, signal).then(
        (stamp) => (failures.delete(repoPath), stamp),
        (error: unknown) => {
          failures.set(repoPath, safe(error instanceof Error ? error.message : String(error)).slice(0, 400));
          throw error;
        },
      ).finally(() => {
        if (inflight.get(repoPath) === entry) inflight.delete(repoPath);
      });
      inflight.set(repoPath, entry);
      return entry;
    },

    buildBranch(input) {
      if (!TASK_ID.test(input.taskId)) return Promise.resolve({ state: "failed", reason: "not a usable task id" });
      if (!COMMIT.test(input.commit)) return Promise.resolve({ state: "failed", reason: "not a usable commit id" });
      const key = keyOf(input.repoPath, input.taskId);
      wanted.set(key, input.commit);
      const epoch = epochs.get(key) ?? 0;
      const run = (chains.get(key) ?? Promise.resolve()).then(() => branchNow(input, epoch));
      const settled = run.catch(() => undefined);
      chains.set(key, settled);
      void settled.then(() => {
        if (chains.get(key) === settled) {
          chains.delete(key);
          if (wanted.get(key) === input.commit) wanted.delete(key);
        }
      });
      return run;
    },

    async branchGraph(repoPath, taskId): Promise<BranchGraph | null> {
      if (!TASK_ID.test(taskId)) return null;
      const dir = branchCurrent(repoPath, taskId);
      const stamp = dir ? await readStamp(dir) : null;
      return dir && stamp ? { dir, stamp } : null;
    },

    async dropBranch(repoPath, taskId) {
      if (!TASK_ID.test(taskId)) return;
      const key = keyOf(repoPath, taskId);
      epochs.set(key, (epochs.get(key) ?? 0) + 1);
      wanted.delete(key);
      await rm(cardDirOf(repoPath, taskId), { recursive: true, force: true });
    },

    async locate(repoPath, text, options) {
      const dir = current(repoPath);
      const graph = dir ? await readGraphJson(dir) : null;
      if (!dir || !graph) return null;
      const found = locate(graph, text);
      const stamp = await readStamp(dir);
      const behind = stamp ? await behindOf(repoPath, stamp.commit).catch(() => null) : null;
      const owners = found.files.length > 0 ? await ownersText(repoPath).catch(() => null) : null;
      const rules = parseCodeowners(owners ?? "");
      const bar = options?.staleCommits ?? FACTORY_DEFAULTS.graph.stale_commits;
      return { ...found, owners: requiredOwners(found.files, rules), codeowners: owners !== null, stale: behind !== null && behind > bar, behind };
    },

    async owners(repoPath, paths) {
      if (!current(repoPath)) return null;
      const text = await ownersText(repoPath).catch(() => null);
      const plain = paths.filter(isPlainRepoPath);
      const dropped = paths.length - plain.length;
      return { owners: text === null ? [] : requiredOwners(plain, parseCodeowners(text)), codeowners: text !== null, ...(dropped > 0 ? { dropped } : {}) };
    },

    async impact(repoPath, files) {
      const dir = current(repoPath);
      const graph = dir ? await readGraphJson(dir) : null;
      return graph ? impact(graph, files) : null;
    },

    async recordMisses(repoPath, miss) {
      await mkdir(dirOf(repoPath), { recursive: true });
      await appendFile(join(dirOf(repoPath), "misses.jsonl"), `${JSON.stringify(miss)}\n`);
    },

    async behind(repoPath, commit) {
      return behindOf(repoPath, commit).catch(() => null);
    },

    async pastMisses(repoPath) {
      const file = join(dirOf(repoPath), "misses.jsonl");
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > MAX_MISSES_BYTES) return [];
        const counts = new Map<string, number>();
        for (const line of (await readFile(file, "utf8")).split("\n")) {
          let row: { files?: unknown };
          try {
            row = JSON.parse(line) as { files?: unknown };
          } catch {
            continue;
          }
          if (!Array.isArray(row.files)) continue;
          for (const f of row.files) if (typeof f === "string" && isPlainRepoPath(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_PAST_MISSES).map(([f]) => f);
      } catch {
        return [];
      }
    },

    health(repoPath) {
      return { building: inflight.has(repoPath), lastFailure: failures.get(repoPath) ?? null };
    },

    async isFresh(repoPath, stamp, baseCommit) {
      const expected = (await deps.graphifyVersion?.().catch(() => null)) ?? null;
      if (expected !== null && stamp.graphify !== expected) return false;
      // The image the repository's stages run in now: a graph built in another one (its base was approved anew) is stale, and one that cannot be compared is too.
      if (deps.imageId) {
        const now = await (async () => deps.imageId!(typeof deps.image === "function" ? await deps.image(repoPath) : deps.image))().catch(() => null);
        if (now === null || stamp.image !== now) return false;
      }
      if (stamp.commit === baseCommit) return true;
      return !(await isAncestor(repoPath, stamp.commit, baseCommit));
    },
  };
}
