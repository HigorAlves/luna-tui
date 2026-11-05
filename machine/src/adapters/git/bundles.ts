// What a container hands back: git bundles in its /out/bundles. The host reads one the way it would read a fetch
// from an untrusted server: a bounded regular file (no symlinks), copied to a place the machine owns, fetched into the
// card's own repository under `refs/luna/in/<run>` with every object checked, and used only as a fast-forward of the
// card's branch. Nothing is read from the container's own `.git`, ever.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { exec } from "../process/exec.ts";
import { at, machineRepoRoot } from "./machine-repo.ts";
import { HOST_GIT, isBranchName } from "./worktree.ts";

/** The most a bundle may weigh. */
export const BUNDLE_CAP_BYTES = 512 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 300_000;
const NAME = /^([1-9]\d{0,5})\.bundle$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export type ImportResult = { ok: true; head: string; changed: boolean } | { ok: false; kind: "head_moved" | "bad_bundle"; reason: string };

const bad = (reason: string): ImportResult => ({ ok: false, kind: "bad_bundle", reason });

/** Copies a regular file, never following a link, up to `max` bytes, into `to`; null with a reason when it is not one or too big. */
function copyBounded(from: string, to: string, max: number): string | null {
  let fd: number;
  try {
    fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return `cannot open the bundle without following a link: ${(error as NodeJS.ErrnoException).code ?? "error"}`;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "the bundle is not a regular file";
    if (stat.size > max) return `the bundle is ${stat.size} bytes, over the ${max} byte cap`;
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > max) return "the bundle grew past the cap while it was read";
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    writeFileSync(to, Buffer.concat(chunks), { mode: 0o600 });
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Imports the bundles a run leaves in `dir` into the card's repository, newest first-come: `sync()` reads the highest-numbered
 * `<n>.bundle` not read before. Each bundle holds everything the run committed since it started, so the newest is enough.
 */
export function bundleImporter(options: { path: string; branch: string; runId: string; dir: string; maxBytes?: number; /** Called with the new tip each time the card's branch moved. */ onAccepted?: (head: string) => Promise<void> }) {
  let lastRead = 0;
  const max = options.maxBytes ?? BUNDLE_CAP_BYTES;
  return {
    async sync(): Promise<ImportResult> {
      const git = (...args: string[]) => exec("git", [...HOST_GIT, ...at(options.path), ...args]);
      const refHead = async (ref: string) => {
        const out = await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
        return out.code === 0 ? out.stdout.trim() : null;
      };
      if (!isBranchName(options.branch) || !RUN.test(options.runId)) return bad("not a usable branch or run name");
      const current = await refHead(`refs/heads/${options.branch}`);
      if (!current) return bad(`the card's repository has no branch ${options.branch}`);
      // The folder must be a real folder, not a link to somewhere else.
      let names: string[];
      try {
        if (lstatSync(options.dir).isSymbolicLink() || realpathSync(options.dir) !== resolve(options.dir)) return bad("the bundles folder is a link");
        names = readdirSync(options.dir);
      } catch {
        return { ok: true, head: current, changed: false };
      }
      const newest = Math.max(0, ...names.flatMap((name) => (NAME.test(name) ? [Number(NAME.exec(name)![1])] : [])));
      if (newest === 0 || newest <= lastRead) return { ok: true, head: current, changed: false };
      lastRead = newest;
      const holding = join(machineRepoRoot(), "in");
      mkdirSync(holding, { recursive: true });
      const copy = join(holding, `${randomUUID()}.bundle`);
      try {
        const refused = copyBounded(join(options.dir, `${newest}.bundle`), copy, max);
        if (refused) return bad(refused);
        const ref = `refs/luna/in/${options.runId}`;
        const fetched = await exec(
          "git",
          [...HOST_GIT, ...at(options.path), "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", copy, `+HEAD:${ref}`],
          { timeoutMs: FETCH_TIMEOUT_MS },
        );
        if (fetched.code !== 0) return bad(`the bundle could not be read: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`);
        const tip = await refHead(ref);
        if (!tip) return bad("the bundle holds no HEAD");
        if (tip === current) return { ok: true, head: current, changed: false };
        const descends = await git("merge-base", "--is-ancestor", current, tip);
        if (descends.code !== 0) return { ok: false, kind: "head_moved", reason: `the run's commits do not descend from the card's branch at ${current.slice(0, 7)}` };
        // Compare-and-swap: the branch moves only if it is still where it was read.
        const moved = await git("update-ref", `refs/heads/${options.branch}`, tip, current);
        if (moved.code !== 0) return { ok: false, kind: "head_moved", reason: "the card's branch moved while the bundle was read" };
        // The index follows the branch (the folder is not touched): a folder that equals the tip then shows no change.
        await git("read-tree", tip);
        await options.onAccepted?.(tip);
        return { ok: true, head: tip, changed: true };
      } finally {
        rmSync(copy, { force: true });
      }
    },
  };
}
